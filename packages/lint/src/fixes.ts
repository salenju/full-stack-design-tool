/**
 * Lint 的自动修复执行器。
 *
 * 为什么单独成文件而不是塞进 rules：修复是「改 IR」，规则是「读 IR」。混在一起会让
 * 规则函数拿到写权限——那是最容易写出「Lint 悄悄改了用户数据」的地方。
 * 这里只吃 issue 上的 `fix` 载荷，载荷是规则在报告问题时就算好的，执行器不做二次推断。
 *
 * 两条纪律：
 * 1. **不改入参。** 返回新 IR，调用方决定是否写盘。
 * 2. **能做的做，不能做的说清原因。** 例如枚举字段缺取值——猜一组值比不修更糟，
 *    因为用户会以为工具知道业务语义。
 */
import { createField, type Field, type IR, type IRNode, type PageComponent } from '@fsdt/core-ir';

import type { LintFix, LintIssue } from './rules.js';

export interface SkippedFix {
  issue: LintIssue;
  reason: string;
}

export interface ApplyFixResult {
  ir: IR;
  /** 实际生效的修复（按应用顺序） */
  applied: Array<{ issue: LintIssue; fix: LintFix }>;
  skipped: SkippedFix[];
}

function findNode(ir: IR, nodeId: string): IRNode | undefined {
  return ir.nodes.find((n) => n.id === nodeId);
}

function eachField(node: IRNode): Field[] {
  switch (node.kind) {
    case 'table':
      return node.table.fields;
    case 'api':
      return [
        ...node.api.pathParams,
        ...node.api.query,
        ...node.api.headers,
        ...(node.api.requestBody?.fields ?? []),
        ...node.api.responses.flatMap((r) => r.fields),
      ];
    default:
      return [];
  }
}

/** 在节点内的任意分区里找字段，并把「找到并替换」这件小事集中在一处 */
function replaceField(node: IRNode, fieldId: string, next: Field): boolean {
  const swap = (list: Field[]): boolean => {
    const index = list.findIndex((f) => f.id === fieldId);
    if (index < 0) return false;
    list[index] = next;
    return true;
  };

  switch (node.kind) {
    case 'table':
      return swap(node.table.fields);
    case 'api': {
      if (swap(node.api.pathParams) || swap(node.api.query) || swap(node.api.headers)) return true;
      if (node.api.requestBody !== undefined && swap(node.api.requestBody.fields)) return true;
      for (const response of node.api.responses) {
        if (swap(response.fields)) return true;
      }
      return false;
    }
    default:
      return false;
  }
}

function allComponents(ir: IR): PageComponent[] {
  return ir.nodes.flatMap((n) => (n.kind === 'page' ? n.page.components : []));
}

/** 字段 ID → 所属节点。renameField 的 fix 载荷里只有 fieldId，没有 nodeId */
function ownerOfField(ir: IR, fieldId: string): IRNode | undefined {
  return ir.nodes.find((node) => eachField(node).some((f) => f.id === fieldId));
}

/**
 * 应用一组 issue 上的修复。
 *
 * 同一个字段可能被多条规则各修一次（例如 L010 改名、L008 补枚举），
 * 所以每次都重新查找节点，而不是缓存引用——缓存会在第一次替换后指向旧对象。
 */
export function applyFixes(ir: IR, issues: LintIssue[]): ApplyFixResult {
  const draft = structuredClone(ir);
  const applied: ApplyFixResult['applied'] = [];
  const skipped: SkippedFix[] = [];

  for (const issue of issues) {
    const fix = issue.fix;
    if (fix === undefined) continue;

    const skip = (reason: string): void => {
      skipped.push({ issue, reason });
    };

    switch (fix.kind) {
      case 'renameNode': {
        const node = findNode(draft, fix.nodeId);
        if (node === undefined) {
          skip('节点已不存在');
          break;
        }
        // L010 的 renameNode 改的是 table.dbName，不是展示名；用 from 值判断落在哪个属性上，
        // 比再给 fix 加一个字段更省事，也不会让已有的 issue 结构失效。
        if (node.kind === 'table' && node.table.dbName === fix.from) {
          node.table.dbName = fix.to;
          applied.push({ issue, fix });
        } else if (node.name === fix.from) {
          node.name = fix.to;
          applied.push({ issue, fix });
        } else {
          skip(`节点上找不到值为「${fix.from}」的属性，可能已被手工修改`);
        }
        break;
      }

      case 'renameField': {
        const node = ownerOfField(draft, fix.fieldId);
        if (node === undefined) {
          skip('字段所属节点已不存在');
          break;
        }
        const field = eachField(node).find((f) => f.id === fix.fieldId);
        if (field === undefined) {
          skip('字段已不存在');
          break;
        }
        if (field.name !== fix.from) {
          skip(`字段当前名为「${field.name}」，与修复前提「${fix.from}」不符`);
          break;
        }
        replaceField(node, fix.fieldId, { ...field, name: fix.to });
        applied.push({ issue, fix });
        break;
      }

      case 'setRoute': {
        const page = findNode(draft, fix.pageId);
        if (page === undefined || page.kind !== 'page') {
          skip('页面已不存在');
          break;
        }
        page.page.route = fix.to;
        applied.push({ issue, fix });
        break;
      }

      case 'addPaginationParams': {
        const api = findNode(draft, fix.apiNodeId);
        if (api === undefined || api.kind !== 'api') {
          skip('接口已不存在');
          break;
        }
        const existing = new Set(api.api.query.map((f) => f.name));
        const added: string[] = [];
        if (!existing.has('page')) {
          api.api.query.push(
            createField({
              name: 'page',
              type: 'integer',
              required: false,
              nullable: false,
              comment: '页码，从 1 开始',
            }),
          );
          added.push('page');
        }
        if (!existing.has('pageSize')) {
          api.api.query.push(
            createField({
              name: 'pageSize',
              type: 'integer',
              required: false,
              nullable: false,
              comment: '每页条数',
            }),
          );
          added.push('pageSize');
        }
        if (added.length === 0) skip('分页参数已存在');
        else applied.push({ issue, fix });
        break;
      }

      case 'addEnumValues': {
        // 候选值属于业务语义，工具猜不出来。给出可操作的提示比塞一组假值有用。
        skip('枚举取值无法推断，请在字段约束里手填 enumValues 或引用枚举字典');
        break;
      }

      case 'bindField': {
        const component = allComponents(draft).find((c) => c.id === fix.componentId);
        if (component === undefined) {
          skip('组件已不存在');
          break;
        }
        // 所有组件都继承 ComponentBase（含 bindings），所以不需要按类型分支
        if (component.bindings.some((b) => b.fieldRef === fix.fieldId)) {
          skip('组件已绑定该字段');
          break;
        }
        component.bindings.push({ fieldRef: fix.fieldId });
        applied.push({ issue, fix });
        break;
      }

      case 'removeEdge': {
        const before = draft.edges.length;
        draft.edges = draft.edges.filter((e) => e.id !== fix.edgeId);
        if (draft.edges.length === before) skip('连线已不存在');
        else applied.push({ issue, fix });
        break;
      }

      default: {
        skip(`未知的修复类型：${(fix as { kind?: string }).kind ?? '?'}`);
      }
    }
  }

  return { ir: draft, applied, skipped };
}

/** 摘要一行，给 CLI 与工作台复用 */
export function summarizeFixes(result: ApplyFixResult): string {
  if (result.applied.length === 0 && result.skipped.length === 0) return '没有可自动修复的问题。';
  const parts: string[] = [];
  if (result.applied.length > 0) parts.push(`已修复 ${result.applied.length} 项`);
  if (result.skipped.length > 0) parts.push(`跳过 ${result.skipped.length} 项`);
  return `${parts.join('，')}。`;
}
