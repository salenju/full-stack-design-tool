/**
 * `fsdt lint`
 *
 * 三种输出格式对应三类消费者：
 * - `text`：人看，带文件名/规则名，可点击（编辑器里点路径能跳）；
 * - `json`：脚本看，稳定结构（可 `| jq`）；
 * - `sarif`：GitHub Code Scanning 看（TD 16.7 的 CI 集成）。
 *
 * `--fail-on` 决定退出码，而不是让 `blocked` 直接决定：
 * 很多团队会先只拦 error，等存量 warn 清完再升级。硬编码会让工具无法渐进接入。
 */

import { saveIR } from '@fsdt/core-ir';
import { applyFixes, runLint, summarizeFixes, toSarif, type LintIssue, type LintSeverity } from '@fsdt/lint';
import { flagBool, flagList, flagString, rejectUnknown, type ParsedArgs } from '../args.js';
import type { CommandContext } from '../context.js';
import { EXIT_FAIL, EXIT_OK, EXIT_USAGE, UsageError } from '../io.js';
import { findIr, loadIrFrom } from '../ir-source.js';

const SEVERITY_ORDER: Record<LintSeverity, number> = { error: 0, warn: 1, info: 2 };

const ALLOWED = ['ir', 'format', 'fail-on', 'only', 'except', 'fix', 'help'];

export function renderTextIssues(issues: LintIssue[]): string {
  if (issues.length === 0) return '✓ 没有发现问题。\n';
  const lines = issues.map((issue) => {
    const where = [
      issue.target.nodeId !== undefined ? `node=${issue.target.nodeId}` : undefined,
      issue.target.fieldId !== undefined ? `field=${issue.target.fieldId}` : undefined,
      issue.target.componentId !== undefined ? `component=${issue.target.componentId}` : undefined,
      issue.target.edgeId !== undefined ? `edge=${issue.target.edgeId}` : undefined,
    ].filter((v): v is string => v !== undefined);
    const tag = issue.severity === 'error' ? '错误' : issue.severity === 'warn' ? '警告' : '提示';
    const fix = issue.fix === undefined ? '' : `（可自动修复：${issue.fix.kind}）`;
    return `  ${tag} ${issue.ruleId} ${issue.message}${fix}${where.length > 0 ? ` [${where.join(' ')}]` : ''}`;
  });
  return `${lines.join('\n')}\n`;
}

export async function runLintCommand(args: ParsedArgs, ctx: CommandContext): Promise<number> {
  const unknown = rejectUnknown(args, ALLOWED);
  if (unknown.length > 0) throw new UsageError(unknown.join('\n'));

  const format = flagString(args, 'format') ?? 'text';
  if (!['text', 'json', 'sarif'].includes(format)) {
    throw new UsageError(`--format 只支持 text | json | sarif，收到：${format}`);
  }
  const failOn = flagString(args, 'fail-on') ?? 'error';
  if (!['error', 'warn', 'info', 'none'].includes(failOn)) {
    throw new UsageError(`--fail-on 只支持 error | warn | info | none，收到：${failOn}`);
  }

  const source = findIr(ctx.cwd, flagString(args, 'ir'));
  const { ir, migrated, backupPath } = await loadIrFrom(source);

  // 迁移提示走 stderr：JSON/SARIF 消费方不该被这条提示污染
  if (migrated.length > 0) {
    ctx.io.stderr(
      `⚠ IR 已从版本 ${migrated.join(' → ')} 迁移到当前版本${backupPath !== undefined ? `，原文件备份在 ${backupPath}` : ''}`,
    );
  }

  const only = flagList(args, 'only');
  const except = flagList(args, 'except');
  const lintOptions = {
    ...(only.length > 0 ? { only } : {}),
    ...(except.length > 0 ? { except } : {}),
    // IR00x 也一并报：否则会出现「gen 拦住了、lint 说 0 问题」的自相矛盾
    includeIRDiagnostics: true,
  };
  let current = ir;
  let result = runLint(current, lintOptions);

  if (flagBool(args, 'fix')) {
    const outcome = applyFixes(current, result.issues);
    if (outcome.applied.length > 0) {
      // saveIR 会重跑语义校验：修复本身把 IR 改坏了，应该在这里失败而不是写进文件
      await saveIR(source.path, outcome.ir);
      current = outcome.ir;
      result = runLint(current, lintOptions);
      ctx.io.stderr(`已写回 ${source.path}`);
    }
    ctx.io.stderr(summarizeFixes(outcome));
    for (const item of outcome.skipped) {
      ctx.io.stderr(`  跳过 ${item.issue.ruleId}：${item.reason}`);
    }
    // 字段重命名只改目标字段。IR 里表字段与接口 DTO 字段是独立实体（IR002），
    // 工具无法断定「两个同名字段是同一个业务概念」，所以不做跨实体连带改名。
    const renamed = outcome.applied.some((a) => a.fix.kind === 'renameField');
    if (renamed && result.issues.some((i) => i.ruleId === 'L014')) {
      ctx.io.stderr('  提示：字段已重命名，接口 DTO 里的同名字段需要同步改（L014 会一直提示到改完）。');
    }
  }

  if (format === 'json') {
    ctx.io.stdout(
      JSON.stringify(
        {
          ir: source.path,
          issues: result.issues,
          ignored: result.ignored,
          stats: result.stats,
          blocked: result.blocked,
        },
        null,
        2,
      ),
    );
  } else if (format === 'sarif') {
    ctx.io.stdout(JSON.stringify(toSarif(result), null, 2));
  } else {
    ctx.io.stdout(renderTextIssues(result.issues));
    ctx.io.stderr(
      `统计：${result.stats.error} 错误 / ${result.stats.warn} 警告 / ${result.stats.info} 提示` +
        (result.ignored.length > 0 ? `，${result.ignored.length} 项已忽略` : ''),
    );
  }

  if (failOn === 'none') return EXIT_OK;
  const threshold = SEVERITY_ORDER[failOn as LintSeverity];
  const worst = result.issues.reduce<number | undefined>((min, issue) => {
    const rank = SEVERITY_ORDER[issue.severity];
    return min === undefined || rank < min ? rank : min;
  }, undefined);
  return worst !== undefined && worst <= threshold ? EXIT_FAIL : EXIT_OK;
}

export { EXIT_USAGE };
