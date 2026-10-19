/**
 * `fsdt init`：在仓库内初始化文件模式的 `design/`。
 *
 * 为什么强调「文件模式」：TD 5.2 定义了两套存储，而 CLI 只服务文件模式
 * （服务模式由 `fsdt serve` 背后的服务端负责）。这里刻意**不**创建
 * `~/.fsdt/`，也不建 SQLite 索引——仓库内的 `design/` 就是权威存储。
 *
 * 已存在的文件绝不覆盖：`fsdt init` 可能在已有项目里被误执行，
 * 而 `ir.json` 是用户全部设计的载体，覆盖它等于删库。
 */

import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createEmptyIR, saveIR } from '@fsdt/core-ir';
import { rejectUnknown, type ParsedArgs } from '../args.js';
import type { CommandContext } from '../context.js';
import { EXIT_FAIL, EXIT_OK, UsageError, rel } from '../io.js';
import { DESIGN_DIR, IR_FILE } from '../ir-source.js';

const ALLOWED = ['name', 'force', 'help'];

export async function runInitCommand(args: ParsedArgs, ctx: CommandContext): Promise<number> {
  const unknown = rejectUnknown(args, ALLOWED);
  if (unknown.length > 0) throw new UsageError(unknown.join('\n'));

  const designDir = join(ctx.cwd, DESIGN_DIR);
  const irPath = join(designDir, IR_FILE);
  const nameFlag = args.flags.get('name');
  const projectName = typeof nameFlag === 'string' ? nameFlag : ctx.cwd.split('/').pop() ?? '未命名项目';

  await mkdir(designDir, { recursive: true });
  await mkdir(join(designDir, 'assets'), { recursive: true });

  if (existsSync(irPath)) {
    if (!args.flags.has('force')) {
      ctx.io.stderr(`✗ ${rel(ctx.cwd, irPath)} 已存在，未改动。如需重建请先手动备份并删除该文件。`);
      return EXIT_FAIL;
    }
    ctx.io.stderr(`⚠ --force：将覆盖已有 ${rel(ctx.cwd, irPath)}`);
  }

  const ir = createEmptyIR({ projectName });
  await saveIR(irPath, ir);

  // .gitignore 只忽略产物与临时文件，design/ 本身必须进版本库——
  // 这是文件模式的全部意义：契约与代码同仓、同 diff、同评审。
  const gitignore = join(designDir, '.gitignore');
  if (!existsSync(gitignore)) {
    await writeFile(
      gitignore,
      ['# 导入的原始设计图体积大且可重新拉取，默认不入库', 'assets/raw/', '', '# 生成过程的历史快照', 'snapshots/', ''].join('\n'),
      'utf8',
    );
  }

  ctx.io.stderr('✓ 已初始化文件模式');
  ctx.io.stdout(
    [
      `design/${IR_FILE}`,
      `design/assets/`,
      '',
      '下一步：',
      '  fsdt compile --stdout json   # 查看当前 IR 编译出的契约（空项目）',
      '  fsdt lint                    # 跑一遍规则',
      '  fsdt gen --out ./output      # 生成前后端骨架',
    ].join('\n'),
  );
  return EXIT_OK;
}

export function irPathOf(cwd: string): string {
  return join(cwd, DESIGN_DIR, IR_FILE);
}
