/**
 * `fsdt serve`：启动服务模式。
 *
 * 服务模式管的是「多项目 + 快照 + 生成历史」，权威存储在 `~/.fsdt/`；
 * 文件模式（`design/ir.json`）仍然是 CLI 与 CI 的默认路径，两者互不干扰。
 *
 * 默认只监听 127.0.0.1：这个服务能改项目文件、能生成代码，等价于本机写权限，
 * 监听 0.0.0.0 等于把它挂到网上。要对外暴露请自己确认网络边界。
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

import { startServer, type RunningServer } from '@fsdt/server';

import { flagList, flagString, rejectUnknown, type ParsedArgs } from '../args.js';
import type { CommandContext } from '../context.js';
import { EXIT_OK, UsageError } from '../io.js';

const ALLOWED = ['port', 'host', 'home', 'allow-origin', 'help'];

/** 服务模式的家目录；可用 FSDT_HOME 覆盖（测试与多实例用） */
export function defaultHome(env: Record<string, string | undefined>): string {
  const override = env['FSDT_HOME'];
  if (override !== undefined && override.length > 0) return override;
  return join(homedir(), '.fsdt');
}

/**
 * 启动服务但不阻塞。
 *
 * 单独抽出来是为了可测：测试起一个服务、打几个请求、关掉，不需要发信号。
 */
export async function startServe(
  args: ParsedArgs,
  ctx: CommandContext,
): Promise<{ running: RunningServer; port: number }> {
  const unknown = rejectUnknown(args, ALLOWED);
  if (unknown.length > 0) throw new UsageError(unknown.join('\n'));

  const portRaw = flagString(args, 'port');
  const port = portRaw === undefined ? 4590 : Number(portRaw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new UsageError(`--port 需要 0–65535 的整数，收到：${portRaw}`);
  }
  const host = flagString(args, 'host') ?? '127.0.0.1';
  const home = flagString(args, 'home') ?? defaultHome(ctx.env);
  const allowOrigin = flagList(args, 'allow-origin');

  const running = await startServer({ home, host, port, allowOrigin });
  return { running, port: running.port };
}

export async function runServeCommand(args: ParsedArgs, ctx: CommandContext): Promise<number> {
  const { running } = await startServe(args, ctx);
  ctx.io.stderr(`✓ fsdt 服务已启动：${running.url}`);
  ctx.io.stderr(`  数据目录：${running.store.home}`);
  ctx.io.stderr('  按 Ctrl+C 停止。');
  ctx.io.stdout(running.url);

  await new Promise<void>((resolve) => {
    const stop = (): void => {
      void running.close().then(() => resolve());
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  ctx.io.stderr('已停止。');
  return EXIT_OK;
}
