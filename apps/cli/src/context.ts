/**
 * 命令上下文：一次调用所需的全部环境。
 *
 * 显式传上下文而不是让命令直接读 `process.cwd()` / `process.env`，
 * 是为了让命令能在测试里被直接调用（`runCli(['lint'], { cwd: tmp })`），
 * 而不必起子进程、改全局环境。
 */

import type { CliIO } from './io.js';
import { defaultIO } from './io.js';

export interface CommandContext {
  cwd: string;
  env: Record<string, string | undefined>;
  io: CliIO;
  /** 统一取环境变量，便于测试注入 */
  envOf(key: string): string | undefined;
}

export function createContext(partial: Partial<CommandContext> = {}): CommandContext {
  const env = partial.env ?? (process.env as Record<string, string | undefined>);
  return {
    cwd: partial.cwd ?? process.cwd(),
    env,
    io: partial.io ?? defaultIO,
    envOf: (key) => env[key],
  };
}
