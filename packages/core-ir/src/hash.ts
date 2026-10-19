/**
 * IR 语义哈希。
 *
 * 为什么需要它：
 * - `PUT /canvases/:id` 用 `If-Match: <hash>` 做乐观锁；
 * - manifest 记录 `schemaHash`，`fsdt gen --check` 据此判断「契约变了但没重新生成」；
 * - 三方合并以「上次生成时的哈希」为共同祖先。
 *
 * 关键：哈希必须建立在**规范化后的语义**上，而不是文件字节上。
 * 因此这里先剥掉所有「不影响产物」的字段（节点坐标、折叠状态、视口、画布背景…），
 * 再对剩余部分做 canonical JSON 序列化后取 SHA-256。
 *
 * 副作用（刻意的）：拖动节点、折叠面板、缩放画布**不会**改变 schemaHash，
 * 所以不会触发无意义的重新生成与漂移告警。
 *
 * 注意：本文件依赖 `node:crypto`，仅用于 Node 环境（服务端 / CLI / 测试）。
 * 前端如需哈希请由服务端下发，不要 import 本模块。
 */

import { createHash } from 'node:crypto';

import { canonicalize } from './canonical.js';
import type { IR, IRNode } from './types.js';

/** 影响产物的节点字段（其余一律视为「纯展示」） */
interface NodeHashView {
  id: string;
  kind: IR['nodes'][number]['kind'];
  name: string;
  codeName: string;
  tags: string[];
  table?: unknown;
  api?: unknown;
  page?: unknown;
}

function stripNodeForHash(node: IRNode): NodeHashView {
  const base: NodeHashView = {
    id: node.id,
    kind: node.kind,
    name: node.name,
    codeName: node.codeName,
    tags: node.tags,
  };

  switch (node.kind) {
    case 'table':
      return { ...base, table: node.table };
    case 'api':
      return { ...base, api: node.api };
    case 'page':
      return { ...base, page: node.page };
    case 'note':
      // 备注不参与编译，但参与评审；把文字纳入哈希会制造噪音，故排除
      return { ...base, kind: 'note' };
    default: {
      const never: never = node;
      return never;
    }
  }
}

/** 影响产物的边字段：去掉画布归属与纯视觉 label */
interface EdgeHashView {
  id: string;
  kind: IR['edges'][number]['kind'];
  source: { nodeId: string; fieldId?: string };
  target: { nodeId: string; fieldId?: string };
  transform?: unknown;
  trigger?: unknown;
  nav?: unknown;
}

function stripEdgeForHash(edge: IR['edges'][number]): EdgeHashView {
  return {
    id: edge.id,
    kind: edge.kind,
    source: { nodeId: edge.source.nodeId, ...(edge.source.fieldId ? { fieldId: edge.source.fieldId } : {}) },
    target: { nodeId: edge.target.nodeId, ...(edge.target.fieldId ? { fieldId: edge.target.fieldId } : {}) },
    ...(edge.transform !== undefined ? { transform: edge.transform } : {}),
    ...(edge.trigger !== undefined ? { trigger: edge.trigger } : {}),
    ...(edge.nav !== undefined ? { nav: edge.nav } : {}),
  };
}

export interface HashSubjectOptions {
  /** 只算某一块画布（服务模式按画布乐观锁时用） */
  canvasId?: string;
}

/**
 * 构造「参与哈希的语义视图」。
 * 导出它是为了测试与排查：当两个 IR 哈希不同时，可以直接 diff 这个视图。
 */
export function semanticView(ir: IR, options: HashSubjectOptions = {}): unknown {
  const inScope = <T extends { canvasId: string }>(item: T): boolean =>
    options.canvasId === undefined || item.canvasId === options.canvasId;

  return {
    schemaVersion: ir.schemaVersion,
    project: {
      name: ir.project.name,
      ...(ir.project.packageScope !== undefined ? { packageScope: ir.project.packageScope } : {}),
    },
    canvases:
      options.canvasId === undefined
        ? ir.canvases.map((c) => ({ id: c.id, name: c.name, order: c.order }))
        : ir.canvases.filter((c) => c.id === options.canvasId).map((c) => ({ id: c.id, name: c.name, order: c.order })),
    nodes: ir.nodes.filter(inScope).map(stripNodeForHash).sort((a, b) => cmp(a.id, b.id)),
    edges: ir.edges.filter(inScope).map(stripEdgeForHash).sort((a, b) => cmp(a.id, b.id)),
    dictionaries: {
      enums: [...ir.dictionaries.enums].sort((a, b) => cmp(a.id, b.id)),
      models: [...ir.dictionaries.models].sort((a, b) => cmp(a.id, b.id)),
    },
    settings: ir.settings,
  };
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function computeSchemaHash(ir: IR, options: HashSubjectOptions = {}): string {
  const text = canonicalize(semanticView(ir, options));
  return 'sha256:' + createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 去掉 `sha256:` 前缀的裸哈希，用于 manifest 与日志比对 */
export function bareHash(hash: string): string {
  return hash.startsWith('sha256:') ? hash.slice('sha256:'.length) : hash;
}

/** 单个文件的哈希（用于 manifest 的 files[].hash） */
export function hashContent(content: string): string {
  return 'sha256:' + createHash('sha256').update(content, 'utf8').digest('hex');
}

/** 生成区块哈希（用于 @dsg:generated 区块的三方合并基准） */
export function hashRegion(content: string): string {
  return createHash('sha256').update(content.trim(), 'utf8').digest('hex').slice(0, 16);
}
