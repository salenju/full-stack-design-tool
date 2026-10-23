/**
 * @fsdt/lint 公共入口。
 *
 * Lint 独立成包（不塞进 compiler）的理由：它要被三个地方调用，而这三个地方
 * 对「输出格式」的要求完全不同——前端要 LintIssue 做点击跳转，CLI 要退出码，
 * 服务端门禁要 blocked 布尔值。放在 compiler 里会强迫 compiler 依赖 lint 的呈现层。
 */

export {
  groupByTarget,
  runLint,
  toSarif,
  LINT_RULES,
  pathParamsOf,
} from './rules.js';
export { applyFixes, summarizeFixes } from './fixes.js';
export type { ApplyFixResult, SkippedFix } from './fixes.js';
export type {
  LintContext,
  LintFix,
  LintIssue,
  LintOptions,
  LintResult,
  LintRule,
  LintSeverity,
  LintTarget,
} from './rules.js';
