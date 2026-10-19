/**
 * `fsdt diff`：IR 的**语义** diff，不是文本 diff。
 *
 * 为什么不能直接用 `git diff design/ir.json`：IR 里大量内容是编辑态
 * （节点坐标、视口、折叠状态、选中态），挪一下画布就会产生几十行 diff，
 * 真正的契约变化被埋在里面。`computeSchemaHash` 已经用了「语义视图」这个概念，
 * 这里复用同一套判断：**坐标变了不算变**。
 *
 * 输出按「新增 / 删除 / 修改」三类，每条都带节点名与关键字段，
 * 让评审时能一眼看出「这次改动动了哪些契约」。
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { IR, IRNode } from '@fsdt/core-ir';
import { coerceToIR } from '@fsdt/core-ir';
import { flagString, rejectUnknown, type ParsedArgs } from '../args.js';
import type { CommandContext } from '../context.js';
import { EXIT_FAIL, EXIT_OK, UsageError } from '../io.js';
import { findIr, loadIrFrom } from '../ir-source.js';

const ALLOWED = ['ir', 'from', 'format', 'help'];

export interface NodeDiff {
  added: IRNode[];
  removed: IRNode[];
  changed: Array<{ before: IRNode; after: IRNode; fields: string[] }>;
}

/**
 * 比较两个节点时只看「契约相关」字段。
 *
 * 刻意用一份白名单而不是黑名单（排除 position/size/collapsed）：
 * 黑名单模式在 IR 增加新编辑态字段时会静默失效，导致 diff 噪音重新出现。
 */
function contractView(node: IRNode): Record<string, unknown> {
  const base = { name: node.name, codeName: node.codeName, kind: node.kind };
  if (node.kind === 'table') {
    return {
      ...base,
      dbName: node.table.dbName,
      fields: node.table.fields.map(fieldView),
      softDelete: node.table.softDelete,
      timestamps: node.table.timestamps,
    };
  }
  if (node.kind === 'api') {
    return {
      ...base,
      method: node.api.method,
      path: node.api.path,
      auth: node.api.auth,
      query: node.api.query.map(fieldView),
      pathParams: node.api.pathParams.map(fieldView),
      requestBody: node.api.requestBody?.fields.map(fieldView) ?? null,
      responses: node.api.responses.map((r) => ({ status: r.status, shape: r.shape, fields: r.fields.map(fieldView) })),
    };
  }
  if (node.kind === 'page') {
    return {
      ...base,
      route: node.page.route,
      layout: node.page.layout,
      components: node.page.components.map((c) => ({ id: c.id, type: c.type })),
    };
  }
  return base;
}

function fieldView(field: { name: string; type: string; required: boolean; constraints?: unknown }): unknown {
  return { name: field.name, type: field.type, required: field.required, constraints: field.constraints ?? null };
}

function changedFields(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const out: string[] = [];
  for (const key of keys) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) out.push(key);
  }
  return out.sort();
}

export function diffIR(before: IR, after: IR): NodeDiff {
  const beforeById = new Map(before.nodes.map((n) => [n.id, n]));
  const afterById = new Map(after.nodes.map((n) => [n.id, n]));
  const diff: NodeDiff = { added: [], removed: [], changed: [] };
  for (const [id, node] of afterById) {
    const prev = beforeById.get(id);
    if (prev === undefined) {
      diff.added.push(node);
      continue;
    }
    const fields = changedFields(contractView(prev), contractView(node));
    if (fields.length > 0) diff.changed.push({ before: prev, after: node, fields });
  }
  for (const [id, node] of beforeById) {
    if (!afterById.has(id)) diff.removed.push(node);
  }
  return diff;
}

function describe(node: IRNode): string {
  if (node.kind === 'api') return `${node.name}（${node.api.method} ${node.api.path}）`;
  if (node.kind === 'table') return `${node.name}（表 ${node.table.dbName}）`;
  if (node.kind === 'page') return `${node.name}（路由 ${node.page.route}）`;
  return `${node.name}（备注）`;
}

async function loadFromRef(path: string): Promise<IR> {
  const text = await readFile(path, 'utf8');
  try {
    return coerceToIR(JSON.parse(text) as unknown, path);
  } catch (error) {
    // coerceToIR 抛的是 IRFileError（带 diagnostics），转成用法错误：
    // 「基线文件版本太老」和「工具崩了」必须区分开，前者用户自己能修。
    const message = error instanceof Error ? error.message : String(error);
    throw new UsageError(`${path} 不是合法 IR：${message}`);
  }
}

export async function runDiffCommand(args: ParsedArgs, ctx: CommandContext): Promise<number> {
  const unknown = rejectUnknown(args, ALLOWED);
  if (unknown.length > 0) throw new UsageError(unknown.join('\n'));

  const source = findIr(ctx.cwd, flagString(args, 'ir'));
  const { ir: after } = await loadIrFrom(source);
  const fromPath = flagString(args, 'from');
  if (fromPath === undefined) {
    throw new UsageError('需要 --from <path|git-ref>：支持文件路径；git ref 请先用 `git show <ref>:design/ir.json > /tmp/base.json`');
  }

  // 明确的取舍：不在此处调 git。让 CLI 直接执行 git 会引入「工作目录状态、
  // 未跟踪文件、子模块」等一堆隐含前提，而 `git show > file` 一行就能把
  // 任何 ref 变成文件。给用户一条可复制的命令，比替用户猜更可靠。
  const before = await loadFromRef(resolve(ctx.cwd, fromPath));
  const diff = diffIR(before, after);

  const format = flagString(args, 'format') ?? 'text';
  if (format === 'json') {
    ctx.io.stdout(
      JSON.stringify(
        {
          added: diff.added.map((n) => ({ id: n.id, kind: n.kind, name: n.name })),
          removed: diff.removed.map((n) => ({ id: n.id, kind: n.kind, name: n.name })),
          changed: diff.changed.map((c) => ({ id: c.after.id, kind: c.after.kind, name: c.after.name, fields: c.fields })),
        },
        null,
        2,
      ),
    );
  } else {
    const lines: string[] = [];
    if (diff.added.length > 0) lines.push(`新增（${diff.added.length}）：\n${diff.added.map((n) => `  + ${describe(n)}`).join('\n')}`);
    if (diff.removed.length > 0) lines.push(`删除（${diff.removed.length}）：\n${diff.removed.map((n) => `  - ${describe(n)}`).join('\n')}`);
    if (diff.changed.length > 0) {
      lines.push(
        `修改（${diff.changed.length}）：\n${diff.changed
          .map((c) => `  ~ ${describe(c.after)}  变化字段：${c.fields.join(', ')}`)
          .join('\n')}`,
      );
    }
    ctx.io.stdout(lines.length === 0 ? '契约无变化（只改了坐标/视口等编辑态）。\n' : `${lines.join('\n')}\n`);
  }

  const total = diff.added.length + diff.removed.length + diff.changed.length;
  // 有差异也返回 0：diff 是**观察**命令，不是门禁。
  // 需要「有变化就失败」的场景请用 `fsdt gen --check`，那里的非零退出码
  // 表示「产物过期」，语义明确；让 diff 也返回非零会让 CI 里 `fsdt diff | grep` 误判。
  ctx.io.stderr(`共 ${total} 处契约变化。`);
  return EXIT_OK;
}

export { EXIT_FAIL };
