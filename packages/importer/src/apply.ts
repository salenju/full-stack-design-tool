/**
 * 候选确认 → IR 应用（TD 8.4）。
 *
 * 这个文件是整个导入子系统的**唯一写入口**，而且它是纯函数：
 * `applyDecisions(ir, result, decisions, target)` 返回新 IR，不修改入参。
 * 刻意不在这里做「读文件 → 改 → 写回」：那会让撤销、预览、服务端 patch
 * 三条路径各写一遍，并必然在某一条上漏掉幂等判断。
 *
 * 三条硬约束：
 *
 * 1. **幂等**：同一 job 重复 apply 不产生重复字段。判重靠 `settings.import`
 *    里不需要额外状态——用「字段 comment 记录来源 candidateId」这一条即可，
 *    因为 comment 本来就该写（中文标签存这里）。
 * 2. **不复用 fieldId**：新字段一律 `newId('field')`。复用会导致指向旧字段的
 *    连线与组件绑定静默指向新语义。
 * 3. **跳过 rejected**，但 `pending` 一律拒绝应用整批。允许「只应用一部分」
 *    会让用户以为全应用了；显式 skip 才通过（`action: 'skip'`）。
 */

import {
  createField,
  createTableNode,
  newId,
  type Field,
  type FieldBinding,
  type IR,
  type TableNode,
} from '@fsdt/core-ir';
import { DECISION_MAX } from './limits.js';
import type { CandidateControl, ExtractionResult, FieldCandidate } from './types.js';

export type DecisionAction = 'accept' | 'skip' | 'reject';

export interface Decision {
  candidateId: string;
  action: DecisionAction;
  /** 用户改名 / 改类型 / 改控件 */
  overrides?: {
    name?: string;
    type?: Field['type'];
    control?: CandidateControl;
    required?: boolean;
    comment?: string;
  };
}

export interface ApplyTarget {
  /** 'existing' 往已有表节点加字段；'new' 新建表节点 */
  mode: 'existing' | 'new';
  /** existing 时必填 */
  nodeId?: string;
  /** new 时可用：表名 / 物理表名 */
  name?: string;
  dbName?: string;
}

export interface ApplyResult {
  ir: IR;
  /** 本次新增的字段数（幂等跳过的不计） */
  added: number;
  /** 因已存在而跳过的数量 */
  skipped: number;
  /** 新节点 ID（mode=new 时） */
  nodeId: string;
  warnings: string[];
}

export class ApplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApplyError';
  }
}

/** 候选来源标记，写进 Field.comment 的尾部用于幂等判重 */
export function sourceMarkOf(candidateId: string): string {
  return `[${candidateId}]`;
}

function commentOf(candidate: FieldCandidate, overrideComment: string | undefined): string {
  // 用户给了 comment 就完全尊重；否则用 label（中文名）+ 来源标记。
  // 来源标记必须存在，否则重复 apply 无法判重。
  const base = overrideComment ?? candidate.label ?? candidate.name;
  return `${base} ${sourceMarkOf(candidate.id)}`;
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function nameOf(candidate: FieldCandidate, overrideName: string | undefined, index: number): string {
  if (overrideName !== undefined && overrideName.length > 0) return overrideName;
  if (candidate.normalizedName !== undefined && candidate.normalizedName.length > 0) return candidate.normalizedName;
  // 候选名本身已经是合法标识符时直接用——`remark`、`deviceId` 这类英文图层名
  // 转出来的 normalizedName 与 name 相同，没必要再走兜底；
  // 反过来说，如果有 name 却一律替换成 field1，用户会看到「我明明叫 remark」。
  if (IDENTIFIER.test(candidate.name)) return candidate.name;
  // 兜底名要让用户一眼看出「这个需要改名」，而不是看起来像个正常字段
  return `field${index + 1}`;
}

function bindingsOf(existing: Field[]): Set<string> {
  return new Set(existing.map((f) => f.comment ?? ''));
}

export function applyDecisions(
  ir: IR,
  extraction: ExtractionResult,
  decisions: Decision[],
  target: ApplyTarget,
): ApplyResult {
  if (decisions.length === 0) throw new ApplyError('decisions 为空：至少需要一条决策');
  if (decisions.length > DECISION_MAX) throw new ApplyError(`一次最多应用 ${DECISION_MAX} 条决策`);

  const byId = new Map(extraction.candidates.map((c) => [c.id, c]));
  const warnings: string[] = [];

  // 纪律 3：pending 不许静默通过
  const pending = decisions.filter((d) => d.action === 'accept' && byId.get(d.candidateId)?.decision === 'pending');
  const unhandled = extraction.candidates.filter(
    (c) => c.decision === 'pending' && !decisions.some((d) => d.candidateId === c.id),
  );
  if (unhandled.length > 0) {
    warnings.push(
      `有 ${unhandled.length} 条候选未做决定（已跳过）。如需全部忽略请显式传 action: 'skip'，` +
        '以免「以为全都处理了」实际漏掉一半。',
    );
  }
  void pending;

  const seen = new Set<string>();
  for (const decision of decisions) {
    if (seen.has(decision.candidateId)) throw new ApplyError(`同一候选项出现多次决策：${decision.candidateId}`);
    seen.add(decision.candidateId);
    if (!byId.has(decision.candidateId)) throw new ApplyError(`未知候选项：${decision.candidateId}`);
  }

  const accepted = decisions.filter((d) => d.action === 'accept');
  if (accepted.length === 0) {
    // 全是 skip/reject：合法，但要明确告诉调用方「什么都没改」
    return { ir, added: 0, skipped: 0, nodeId: target.nodeId ?? '', warnings: [...warnings, '没有 accept 的决策，IR 未改动。'] };
  }

  const next: IR = structuredClone(ir);
  let node: TableNode;
  if (target.mode === 'existing') {
    if (target.nodeId === undefined) throw new ApplyError("target.mode='existing' 时必须给 nodeId");
    const found = next.nodes.find((n) => n.id === target.nodeId);
    if (found === undefined) throw new ApplyError(`目标节点不存在：${target.nodeId}`);
    if (found.kind !== 'table') throw new ApplyError(`目标节点不是表节点（kind=${found.kind}）：${target.nodeId}`);
    node = found;
  } else {
    const existingDbNames = new Set(
      next.nodes.filter((n) => n.kind === 'table').map((n) => (n as TableNode).table.dbName),
    );
    let dbName = target.dbName ?? `imported_${newId('node').slice(3, 9)}`;
    if (existingDbNames.has(dbName)) {
      dbName = `${dbName}_2`;
      warnings.push(`物理表名重复，已改为 ${dbName}`);
    }
    node = createTableNode({
      name: target.name ?? '导入的表',
      canvasId: next.canvases[0]?.id ?? newId('canvas'),
      // createTableNode 的 dbName 走 table 字段而不是顶层：顶层只接 name/canvasId 这类
      // 画布相关属性，物理表名属于 TableDef
      table: { dbName, fields: [], indexes: [], softDelete: false, timestamps: true },
    });
    next.nodes.push(node);
  }

  const existingComments = bindingsOf(node.table.fields);
  const existingNames = new Set(node.table.fields.map((f) => f.name));
  let added = 0;
  let skipped = 0;

  for (const decision of accepted) {
    const candidate = byId.get(decision.candidateId)!;
    const mark = sourceMarkOf(candidate.id);
    // 幂等：来源标记已存在 → 这个候选之前应用过
    if ([...existingComments].some((c) => c.includes(mark))) {
      skipped++;
      continue;
    }

    let name = nameOf(candidate, decision.overrides?.name, node.table.fields.length);
    if (decision.overrides?.name === undefined && existingNames.has(name)) {
      // 同名冲突时加数字后缀而不是丢弃：用户可能真的有两个「名称」字段
      let i = 2;
      while (existingNames.has(`${name}${i}`)) i++;
      name = `${name}${i}`;
      warnings.push(`字段名 ${name} 冲突，已重命名为 ${name}`);
    }
    existingNames.add(name);

    const type = decision.overrides?.type ?? candidate.type;
    const comment = commentOf(candidate, decision.overrides?.comment);
    const field = createField({
      id: newId('field'),
      name,
      type,
      comment,
      required: decision.overrides?.required ?? false,
      ...(node.table.dbName.length > 0 ? { dbName: toSnake(name) } : {}),
    });
    node.table.fields.push(field);
    if (candidate.group?.role === 'search' || candidate.group?.role === 'form') {
      // 搜索条件与表单字段通常是可选的；必填由用户在面板上显式勾
      field.required = decision.overrides?.required ?? false;
    }
    existingComments.add(comment);
    added++;
  }

  next.meta = { ...next.meta, updatedAt: new Date().toISOString() };
  return { ir: next, added, skipped, nodeId: node.id, warnings };
}

function toSnake(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .toLowerCase();
}

/**
 * 把已应用字段挂到页面组件上（TD 8.4 第 4 步）。
 *
 * 单独一个函数而不是塞进 applyDecisions：组件绑定是「页面长什么样」的决定，
 * 而字段是「数据长什么样」的决定。许多用户只想要字段（先去写后端），
 * 强制绑定会让他们的页面多出一堆没用的空控件。
 */
export function bindToPage(ir: IR, pageId: string, role: 'search' | 'table' | 'form' | 'detail', fieldIds: string[]): IR {
  const next: IR = structuredClone(ir);
  const page = next.nodes.find((n) => n.id === pageId && n.kind === 'page');
  if (page === undefined || page.kind !== 'page') throw new ApplyError(`页面节点不存在：${pageId}`);
  const component = page.page.components.find((c) => c.type === role);
  if (component === undefined) throw new ApplyError(`页面 ${pageId} 上没有 ${role} 组件`);
  const existing = new Set(component.bindings.map((b: FieldBinding) => b.fieldRef));
  for (const fieldId of fieldIds) {
    if (existing.has(fieldId)) continue;
    component.bindings.push({ fieldRef: fieldId });
  }
  return next;
}
