/**
 * JSON 导出：IR 子集 + 布局信息。
 *
 * 目标不是「把 IR 复制一份」，而是给**外部工具**（自建的架构图渲染器、
 * 架构治理脚本、把画布喂给别的 AI）一个稳定的、不依赖本工具版本的输入。
 *
 * 因此这份 JSON 与 IR 的关系是「投影」而不是「拷贝」：
 * - 只保留结构信息，丢掉视口、折叠、锁定、素材那些纯编辑态；
 * - 用自描述的扁平结构（每个节点带 `kind` 与 `label`），消费方不需要读 IR 规范；
 * - 显式带 `schemaVersion`，让外部工具有版本判断依据。
 */

import type { EdgeKind, IR, IRNode } from '@fsdt/core-ir';
import { computeSchemaHash } from '@fsdt/core-ir';
import { nodesOfCanvas } from './geometry.js';

export interface JsonExportNode {
  id: string;
  kind: IRNode['kind'];
  label: string;
  codeName: string;
  rect: { x: number; y: number; w: number; h: number };
  /** 结构摘要：表是字段列表、接口是方法与路径、页面是路由 */
  summary: Record<string, unknown>;
}

export interface JsonExportEdge {
  id: string;
  kind: EdgeKind;
  source: string;
  target: string;
  sourceField?: string;
  targetField?: string;
  label?: string;
}

export interface JsonExport {
  schemaVersion: 1;
  generator: string;
  project: { name: string; description?: string };
  canvas: { id: string; name: string };
  /** 语义哈希：外部工具可以据此判断「结构是否变了」 */
  schemaHash: string;
  nodes: JsonExportNode[];
  edges: JsonExportEdge[];
}

export interface JsonOptions {
  includeNotes: boolean;
}

export const DEFAULT_JSON_OPTIONS: JsonOptions = { includeNotes: false };

function summaryOf(node: IRNode): Record<string, unknown> {
  switch (node.kind) {
    case 'table':
      return {
        dbName: node.table.dbName,
        primaryKey: node.table.fields[0]?.name,
        fields: node.table.fields.map((f) => ({
          name: f.name,
          type: f.type,
          required: f.required,
          ...(f.constraints?.ref !== undefined ? { references: f.constraints.ref.tableId } : {}),
        })),
      };
    case 'api':
      return {
        method: node.api.method,
        path: node.api.path,
        auth: node.api.auth,
        pathParams: node.api.pathParams.map((f) => f.name),
        query: node.api.query.map((f) => f.name),
        requestBody: node.api.requestBody?.fields.map((f) => f.name) ?? [],
        responses: node.api.responses.map((r) => ({ status: r.status, shape: r.shape })),
      };
    case 'page':
      return {
        route: node.page.route,
        layout: node.page.layout,
        components: node.page.components.map((c) => ({ id: c.id, type: c.type })),
      };
    case 'note':
      return { text: node.note.text };
  }
}

export function buildJsonExport(ir: IR, canvasId: string, options: Partial<JsonOptions> = {}): JsonExport {
  const opts: JsonOptions = { ...DEFAULT_JSON_OPTIONS, ...options };
  const canvas = ir.canvases.find((c) => c.id === canvasId);
  if (canvas === undefined) throw new Error(`画布不存在：${canvasId}`);

  const nodes = nodesOfCanvas(ir, canvasId).filter((n) => opts.includeNotes || n.kind !== 'note');
  const visible = new Set(nodes.map((n) => n.id));

  return {
    schemaVersion: 1,
    generator: 'fsdt-exporter@0.1.0',
    project: { name: ir.project.name, ...(ir.project.description !== undefined ? { description: ir.project.description } : {}) },
    canvas: { id: canvas.id, name: canvas.name },
    schemaHash: computeSchemaHash(ir),
    nodes: nodes
      .map((n) => ({
        id: n.id,
        kind: n.kind,
        label: n.name,
        codeName: n.codeName,
        rect: { x: n.position.x, y: n.position.y, w: n.size.w, h: n.size.h },
        summary: summaryOf(n),
      }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    edges: ir.edges
      .filter((e) => e.canvasId === canvasId && visible.has(e.source.nodeId) && visible.has(e.target.nodeId))
      .map((e) => ({
        id: e.id,
        kind: e.kind,
        source: e.source.nodeId,
        target: e.target.nodeId,
        ...(e.source.fieldId !== undefined ? { sourceField: e.source.fieldId } : {}),
        ...(e.target.fieldId !== undefined ? { targetField: e.target.fieldId } : {}),
        ...(e.label !== undefined ? { label: e.label } : {}),
      }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  };
}

export function renderJson(ir: IR, canvasId: string, options: Partial<JsonOptions> = {}): string {
  return `${JSON.stringify(buildJsonExport(ir, canvasId, options), null, 2)}\n`;
}
