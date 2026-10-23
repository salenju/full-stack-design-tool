#!/usr/bin/env node
/**
 * fsdt 入口。
 *
 * 结构：main 只做「解析 → 分派 → 映射退出码」，所有业务在 commands/*。
 * 这样每个命令都能在测试里被直接调用（无需起子进程），
 * 而退出码的映射集中在一处，不会出现「某个命令忘了 return 1」。
 *
 * 错误分两类，边界必须清楚：
 * - `UsageError` → 退出码 2，只打一行消息（用户能自己修）；
 * - 其它异常 → 退出码 2 但打**完整栈**（说明是我们自己的 bug，需要报 issue）。
 */

import { parseArgs, flagBool, type ParsedArgs } from './args.js';
import { createContext, type CommandContext } from './context.js';
import { COMMANDS, VERSION, commandHelp, globalHelp } from './help.js';
import { EXIT_FAIL, EXIT_OK, EXIT_USAGE, UsageError } from './io.js';
import { runLintCommand } from './commands/lint.js';
import { runCompileCommand } from './commands/compile.js';
import { runGenCommand } from './commands/gen.js';
import { runSampleCommand } from './commands/sample.js';
import { runExportCommand } from './commands/export.js';
import { runInitCommand } from './commands/init.js';
import { runDiffCommand } from './commands/diff.js';
import { runImportCommand } from './commands/import.js';
import { runServeCommand } from './commands/serve.js';
import { runLinkCommand } from './commands/link.js';

export type CommandRunner = (args: ParsedArgs, ctx: CommandContext) => Promise<number>;

export const RUNNERS: Record<string, CommandRunner> = {
  init: runInitCommand,
  compile: runCompileCommand,
  lint: runLintCommand,
  gen: runGenCommand,
  sample: runSampleCommand,
  export: runExportCommand,
  diff: runDiffCommand,
  import: runImportCommand,
  serve: runServeCommand,
  link: runLinkCommand,
};

/**
 * 可测试的主入口：不直接读 process.argv，也不自己调 process.exit。
 * 返回值就是退出码，调用方（bin 包装或测试）决定怎么用。
 */
export async function runCli(argv: string[], ctx: CommandContext = createContext()): Promise<number> {
  const args = parseArgs(argv);
  const [command, ...rest] = args.positionals;

  if (args.flags.has('version') || command === 'version') {
    ctx.io.stdout(`${VERSION}`);
    return EXIT_OK;
  }
  if (command === undefined || command === 'help' || args.flags.has('help')) {
    const doc = COMMANDS.find((c) => c.name === command);
    ctx.io.stdout(doc !== undefined ? commandHelp(doc) : globalHelp());
    return EXIT_OK;
  }

  const runner = RUNNERS[command];
  if (runner === undefined) {
    ctx.io.stderr(`未知命令：${command}\n\n${globalHelp()}`);
    return EXIT_USAGE;
  }

  // 子命令的 help 要在 runner 之前拦下：否则 `fsdt lint --help` 会先跑 lint、
  // 在没 IR 的目录里报「找不到 design/ir.json」，用户以为命令坏了。
  if (args.flags.has('help')) {
    const doc = COMMANDS.find((c) => c.name === command);
    ctx.io.stdout(doc !== undefined ? commandHelp(doc) : globalHelp());
    return EXIT_OK;
  }

  const withRest: ParsedArgs = { ...args, positionals: rest };
  try {
    return await runner(withRest, ctx);
  } catch (error) {
    if (error instanceof UsageError) {
      ctx.io.stderr(`错误：${error.message}`);
      return EXIT_USAGE;
    }
    const message = error instanceof Error ? error.message : String(error);
    ctx.io.stderr(`内部错误：${message}`);
    if (error instanceof Error && error.stack !== undefined) ctx.io.stderr(error.stack);
    return EXIT_USAGE;
  }
}

/** bin 包装：真正的进程入口 */
async function main(): Promise<void> {
  const ctx = createContext();
  const code = await runCli(process.argv.slice(2), ctx);
  process.exitCode = code;
}

// 只在「被当作可执行文件直接运行」时启动，被 import 时不启动（测试要用）
const invokedDirectly =
  process.argv[1] !== undefined && (process.argv[1].endsWith('/main.js') || process.argv[1].endsWith('/main.ts'));
if (invokedDirectly && !flagBool(parseArgs(process.argv.slice(2)), 'no-run')) {
  await main();
}

export { EXIT_FAIL, EXIT_OK, EXIT_USAGE };
