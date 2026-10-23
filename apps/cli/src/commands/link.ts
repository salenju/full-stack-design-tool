/**
 * `fsdt link`：把仓库里的 `design/` 登记为服务模式里的一个项目。
 *
 * 登记之后，UI 与 CLI 编辑的是**同一份文件**：服务模式不再另存一份，
 * 靠 `If-Match`（IR 的语义哈希）避免两边互相覆盖。
 *
 * 幂等：同一个目录重复 link 返回同一个项目，不会每次多出一条同名项目。
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { ProjectStore } from '@fsdt/server';

import { flagString, rejectUnknown, type ParsedArgs } from '../args.js';
import type { CommandContext } from '../context.js';
import { EXIT_OK, UsageError } from '../io.js';
import { defaultHome } from './serve.js';

const ALLOWED = ['name', 'home', 'help'];

/**
 * 定位 design 目录。
 *
 * 两种传法都接受：给仓库根（里面有 design/）或直接给 design/ 目录。
 * 用户最可能敲的是 `fsdt link .`，所以仓库根必须是能直接用的那一种。
 */
export function resolveDesignDir(cwd: string, target: string): string {
  const abs = resolve(cwd, target);
  if (existsSync(join(abs, 'ir.json'))) return abs;
  if (existsSync(join(abs, 'design', 'ir.json'))) return join(abs, 'design');
  throw new UsageError(
    `找不到 design/ir.json（检查了 ${abs} 与 ${join(abs, 'design')}）。` +
      '先在该目录跑 `fsdt init`，或用 --ir 指定其它位置的 IR。',
  );
}

export async function runLinkCommand(args: ParsedArgs, ctx: CommandContext): Promise<number> {
  const unknown = rejectUnknown(args, ALLOWED);
  if (unknown.length > 0) throw new UsageError(unknown.join('\n'));

  const target = args.positionals[0] ?? '.';
  const designDir = resolveDesignDir(ctx.cwd, target);
  const name = flagString(args, 'name');
  const home = flagString(args, 'home') ?? defaultHome(ctx.env);

  const store = new ProjectStore(home);
  await store.init();
  try {
    const project = await store.linkDirectory(designDir, name);
    ctx.io.stderr(`✓ 已登记：${project.name}（${project.id}）`);
    ctx.io.stderr(`  权威存储：${project.sourcePath ?? designDir}`);
    ctx.io.stderr('  之后 UI 与 CLI 编辑的是同一份文件，靠 If-Match 哈希避免互相覆盖。');
    ctx.io.stdout(project.id);
    return EXIT_OK;
  } finally {
    store.close();
  }
}
