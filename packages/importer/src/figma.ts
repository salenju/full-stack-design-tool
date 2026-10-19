/**
 * Figma 通道：节点树 → 字段候选（TD 8.2）。
 *
 * 为什么这条路比视觉模型更值得做：**节点树是结构化的**。图层名、组件实例名、
 * 文本内容、bbox 全都是确定数据，能拿到约 70% 的字段召回，而且是可复现的——
 * 同一 fileVersion 两次导入得到同一份候选。视觉模型做不到这一点。
 *
 * 三个刻意的设计取舍：
 *
 * 1. **只读 `depth` 限定的节点树，不拉渲染图**。拉 PNG 会慢一个数量级，
 *    而候选面板里我们已经有了 bbox，可以在前端按 bbox 裁剪预览。
 * 2. **打分而不是过滤**。任何一条证据都产生候选，低分候选照样返回、由用户否决。
 *    过滤掉低分项会造成「面板里没有这一项」，用户根本不知道自己漏了什么。
 * 3. **中文图层名不转拼音**（见 naming.ts）。宁可让用户补一个字段名。
 */

import type { FieldType } from '@fsdt/core-ir';
import { FLD_MAX } from './limits.js';
import {
  candidateIdOf,
  inferFromLayerName,
  inferFromText,
  toFieldName,
  toRoute,
} from './naming.js';
import type {
  BBox,
  CandidateControl,
  CandidateExtractor,
  CandidateGroup,
  CandidatePage,
  Evidence,
  ExtractionResult,
  ExtractorContext,
  ExtractorInput,
  FieldCandidate,
  GroupRole,
} from './types.js';

// ────────────────────────────── Figma 节点树的最小类型 ──────────────────────────────

export interface FigmaNode {
  id: string;
  name: string;
  type: string;
  /** 绝对坐标（Figma 的 absoluteBoundingBox） */
  absoluteBoundingBox?: { x: number; y: number; width: number; height: number };
  characters?: string;
  children?: FigmaNode[];
  /** INSTANCE 节点的组件名 */
  componentName?: string;
}

export interface FigmaNodesResponse {
  name?: string;
  lastModified?: string;
  version?: string;
  nodes: Record<string, { document: FigmaNode } | null>;
}

// ────────────────────────────── 打分表（与 TD 8.2 对应） ──────────────────────────────

const W = {
  text: 0.9,
  layerName: 0.85,
  component: 0.8,
  placeholder: 0.75,
  groupName: 0.7,
  bbox: 0.6,
  inferred: 0.65,
} as const;

/** 一组证据的置信度：取最大值再加少量加成，上限 0.99。不用均值——一条强证据就够 */
export function combineConfidence(weights: number[]): number {
  if (weights.length === 0) return 0;
  const max = Math.max(...weights);
  const bonus = Math.min(0.08, (weights.length - 1) * 0.02);
  return Math.min(0.99, Math.round((max + bonus) * 100) / 100);
}

const GROUP_ROLE_BY_NAME: Array<{ pattern: RegExp; role: GroupRole }> = [
  { pattern: /(搜索|查询|筛选|search|filter)/i, role: 'search' },
  { pattern: /(表格|列表|table|list|grid)/i, role: 'table' },
  { pattern: /(详情|detail)/i, role: 'detail' },
  { pattern: /(表单|新建|编辑|form|create|edit|modal|dialog)/i, role: 'form' },
];

export function groupRoleOf(name: string): GroupRole | undefined {
  for (const rule of GROUP_ROLE_BY_NAME) if (rule.pattern.test(name)) return rule.role;
  return undefined;
}

const FORM_ITEM = /^(FormItem|Form-Item|Field|FormField)[/_]/i;
const TABLE_CELL = /^(TableColumn|TableCell|Column|Cell)[/_]/i;

function bboxOf(node: FigmaNode): BBox | undefined {
  const b = node.absoluteBoundingBox;
  return b === undefined ? undefined : { x: b.x, y: b.y, w: b.width, h: b.height };
}

function isInputLike(node: FigmaNode): boolean {
  if (inferFromLayerName(node.name) !== undefined) return true;
  // Figma 里输入框常是 INSTANCE，组件名才可靠
  if (node.componentName !== undefined && inferFromLayerName(node.componentName) !== undefined) return true;
  // 表格列是「只读展示位」，同样要变成候选（control='slot'）。
  // 漏掉它会让表格里一个字段都提不出来——而表格恰恰是导入最常来源。
  return FORM_ITEM.test(node.name) || TABLE_CELL.test(node.name);
}

/**
 * 遍历时维护祖先链。
 *
 * 祖先链决定两件下游都要用的事：字段属于哪个 group（search/table/form），
 * 以及 evidence 里的 `nodePath`（用户点候选要能定位到画布上哪一层）。
 */
interface Walker {
  visit(node: FigmaNode, ancestors: FigmaNode[]): void;
}

interface Draft {
  key: string;
  name: string;
  label?: string;
  type: FieldType;
  control: CandidateControl;
  weights: number[];
  evidence: Evidence[];
  group?: { id: string; label: string; role: GroupRole };
  bbox?: BBox;
}

export interface FigmaExtractorOptions {
  /** 拉取节点的深度，默认 12（够到表格单元格，再多就是噪音） */
  depth?: number;
}

export const FIGMA_API_BASE = 'https://api.figma.com/v1';

const DEFAULT_FETCH = async (url: string, headers: Record<string, string>): Promise<unknown> => {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    // 把状态码说清楚：401/403 是 token 权限问题，404 是 fileKey 写错，
    // 这三种情况用户要做的操作完全不同
    throw new Error(`Figma API ${response.status} ${response.statusText}（${url}）`);
  }
  return response.json();
};

export function createFigmaExtractor(options: FigmaExtractorOptions = {}): CandidateExtractor {
  const depth = options.depth ?? 12;
  return {
    channel: 'figma',
    async extract(input: ExtractorInput, ctx: ExtractorContext = {}): Promise<ExtractionResult> {
      if (input.fileKey === undefined || input.fileKey.length === 0) {
        throw new Error('Figma 导入需要 fileKey');
      }
      if (input.token === undefined || input.token.length === 0) {
        throw new Error('Figma 导入需要 token（应从环境变量 FSDT_FIGMA_TOKEN 读取，不要写进 IR）');
      }
      const nodeIds = input.nodeIds ?? [];
      const params = new URLSearchParams();
      if (nodeIds.length > 0) params.set('ids', nodeIds.join(','));
      params.set('depth', String(depth));
      const url = `${FIGMA_API_BASE}/files/${encodeURIComponent(input.fileKey)}/nodes?${params.toString()}`;

      const fetchJson = ctx.fetchJson ?? DEFAULT_FETCH;
      const raw = (await fetchJson(url, { 'X-Figma-Token': input.token })) as FigmaNodesResponse;
      return extractFromNodes(raw, { fileKey: input.fileKey });
    },
  };
}

/** 纯函数入口：便于用固定 JSON 快照写测试，不需要网络 */
export function extractFromNodes(raw: FigmaNodesResponse, meta: { fileKey: string } = { fileKey: '' }): ExtractionResult {
  const drafts = new Map<string, Draft>();
  const groups = new Map<string, CandidateGroup>();
  const pages: CandidatePage[] = [];
  const warnings: string[] = [];

  const draftsFor = (key: string, init: Omit<Draft, 'weights' | 'evidence'>): Draft => {
    const existing = drafts.get(key);
    if (existing !== undefined) return existing;
    const created: Draft = { ...init, weights: [], evidence: [] };
    drafts.set(key, created);
    return created;
  };

  const groupOfAncestors = (ancestors: FigmaNode[]): Draft['group'] => {
    for (let i = ancestors.length - 1; i >= 0; i--) {
      const node = ancestors[i]!;
      const role = groupRoleOf(node.name);
      if (role !== undefined) {
        const id = candidateIdOf('group', node.id);
        if (!groups.has(id)) {
          groups.set(id, {
            id,
            label: node.name,
            role,
            ...(bboxOf(node) !== undefined ? { bbox: bboxOf(node)! } : {}),
          });
        }
        return { id, label: node.name, role };
      }
    }
    return undefined;
  };

  const roleOfDraft = (draft: Draft): GroupRole | undefined => draft.group?.role;

  const walk = (node: FigmaNode, ancestors: FigmaNode[]): void => {
    const path = [...ancestors, node].map((n) => n.name).join(' / ');

    // 顶层 FRAME 视为一个页面
    if (node.type === 'FRAME' && ancestors.length <= 1 && node.absoluteBoundingBox !== undefined) {
      pages.push({
        name: node.name,
        bbox: bboxOf(node)!,
        suggestedRoute: toRoute(node.name.replace(/^Page\s*[/_-]\s*/i, '').split(/[/_-]/)),
      });
    }

    if (isInputLike(node) && node.type !== 'TEXT') {
      const layer = inferFromLayerName(node.componentName ?? node.name) ?? inferFromLayerName(node.name);
      const tableCell = TABLE_CELL.test(node.name);
      const role = groupOfAncestors(ancestors);
      // 名字只能来自图层名：componentName 是「控件类型」（Select / Input），
      // 拿它当字段名会让所有下拉框都叫 select、所有输入框都叫 input。
      // 它唯一可靠的用途是推断 control（见上面的 layer）。
      const rawName = node.name.replace(FORM_ITEM, '').replace(TABLE_CELL, '');
      const draft = draftsFor(node.id, {
        key: node.id,
        name: rawName,
        type: layer?.type ?? 'string',
        control: tableCell ? 'slot' : layer?.control ?? 'input',
        ...(role !== undefined ? { group: role } : {}),
        ...(bboxOf(node) !== undefined ? { bbox: bboxOf(node)! } : {}),
      });
      if (layer !== undefined) {
        draft.weights.push(W.layerName);
        draft.evidence.push({ kind: 'layerName', value: node.componentName ?? node.name, nodePath: path });
      }
      if (node.componentName !== undefined) {
        draft.weights.push(W.component);
        draft.evidence.push({ kind: 'component', value: node.componentName, nodePath: path });
      }
      const bbox = bboxOf(node);
      if (bbox !== undefined) {
        // bbox 既进 evidence 也进权重。只进 evidence 是一个隐蔽的 bug：
        // 候选的过滤器要求 weights 非空，于是「只有位置信息」的候选（表格列
        // 图层名字面是 TableColumn/deviceId，既不匹配控件表也没有组件名）
        // 会被静默丢弃——面板上就是「表格列一个都没识别出来」。
        draft.weights.push(W.bbox);
        draft.evidence.push({ kind: 'bbox', value: `${bbox.x},${bbox.y} ${bbox.w}×${bbox.h}`, bbox, nodePath: path });
      }
    }

    if (node.type === 'TEXT' && node.characters !== undefined) {
      const text = node.characters.trim();
      const role = groupOfAncestors(ancestors);
      const tableCell = ancestors.some((a) => /(Table|List|Grid|表格|列表)/i.test(a.name));
      const inferred = inferFromText(text);

      // 表格里的文本是**数据**不是标签，用来推断列会得到一堆假列
      if (!tableCell && text.length > 0 && text.length <= 40) {
        const draft = draftsFor(node.id, {
          key: node.id,
          name: toFieldName(text) ?? text,
          label: text,
          type: inferred?.type ?? 'string',
          control: inferred?.control ?? 'input',
          ...(role !== undefined ? { group: role } : {}),
          ...(bboxOf(node) !== undefined ? { bbox: bboxOf(node)! } : {}),
        });
        draft.weights.push(W.text);
        draft.evidence.push({ kind: 'text', value: text, nodePath: path });
        if (inferred !== undefined) {
          draft.weights.push(W.inferred);
          draft.evidence.push({ kind: 'inferred', value: inferred.reason ?? '类型推断', nodePath: path });
        }
        const placeholder = /^(请输入|请选择)/u.test(text);
        if (placeholder) {
          draft.weights.push(W.placeholder);
          draft.evidence.push({ kind: 'placeholder', value: text, nodePath: path });
        }
      }
    }

    for (const child of node.children ?? []) walk(child, [...ancestors, node]);
  };

  for (const entry of Object.values(raw.nodes)) {
    if (entry === null) continue;
    walk(entry.document, []);
  }

  const candidates: FieldCandidate[] = [...drafts.values()]
    // 没有任何证据的候选不该出现：它意味着我们只看到了一个空壳节点
    .filter((d) => d.weights.length > 0)
    .map((d) => {
      const normalizedName = toFieldName(d.name);
      return {
        id: candidateIdOf('figma', d.key),
        name: d.name,
        ...(normalizedName !== undefined ? { normalizedName } : {}),
        ...(d.label !== undefined ? { label: d.label } : {}),
        type: d.type,
        control: d.control,
        confidence: combineConfidence(d.weights),
        evidence: d.evidence,
        ...(d.group !== undefined ? { group: d.group } : {}),
        decision: 'pending' as const,
      };
    })
    .sort((a, b) => b.confidence - a.confidence || (a.id < b.id ? -1 : 1));

  if (candidates.length === 0) {
    warnings.push('没有从节点树中识别出任何字段候选：请确认传入的节点 ID 包含表单/表格层，且图层命名不是纯 ID。');
  }
  if (candidates.length > FLD_MAX) {
    warnings.push(`候选数超过 ${FLD_MAX} 条，已截断。建议缩小 nodeIds 范围后分批导入。`);
  }

  void roleOfDraft;
  void ({} as Walker);
  return {
    candidates: candidates.slice(0, FLD_MAX),
    groups: [...groups.values()].sort((a, b) => (a.id < b.id ? -1 : 1)),
    pages,
    warnings,
    raw: meta.fileKey.length > 0 ? { fileKey: meta.fileKey, nodeCount: Object.keys(raw.nodes).length } : undefined,
  };
}
