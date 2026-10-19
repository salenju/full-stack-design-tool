/**
 * `fsdt sample`：生成示例数据并落成 mock 文件。
 *
 * 默认输出的是**可直接被 MSW / mock 服务器读的 JSON**，而不是一张大表：
 * 一个文件一张表，前端可以按需 import，也让「哪张表的数据变了」在 git 里看得清。
 */

import { generateSamples, toSeedJson } from '@fsdt/sample';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { flagString, rejectUnknown, type ParsedArgs } from '../args.js';
import type { CommandContext } from '../context.js';
import { EXIT_OK, UsageError, rel } from '../io.js';
import { findIr, loadIrFrom } from '../ir-source.js';

const ALLOWED = ['ir', 'out', 'seed', 'count', 'rows', 'mask', 'help'];

export async function runSampleCommand(args: ParsedArgs, ctx: CommandContext): Promise<number> {
  const unknown = rejectUnknown(args, ALLOWED);
  if (unknown.length > 0) throw new UsageError(unknown.join('\n'));

  const seedText = flagString(args, 'seed') ?? flagString(args, 'count');
  const seed = seedText === undefined ? undefined : Number(seedText);
  if (seed !== undefined && !Number.isFinite(seed)) throw new UsageError(`--seed 必须是数字，收到：${seedText}`);
  const rowsText = flagString(args, 'rows');
  const rows = rowsText === undefined ? undefined : Number(rowsText);
  if (rows !== undefined && (!Number.isInteger(rows) || rows < 1)) {
    throw new UsageError(`--rows 必须是正整数，收到：${rowsText}`);
  }

  const source = findIr(ctx.cwd, flagString(args, 'ir'));
  const { ir } = await loadIrFrom(source);
  const result = generateSamples(ir, {
    ...(seed !== undefined ? { seed } : {}),
    ...(rows !== undefined ? { rowsPerTable: rows } : {}),
  });
  for (const w of result.warnings) ctx.io.stderr(`⚠ ${w}`);

  const data = toSeedJson(ir, result);
  const outDir = flagString(args, 'out');
  if (outDir === undefined) {
    ctx.io.stdout(JSON.stringify(data, null, 2));
    return EXIT_OK;
  }

  const dir = join(ctx.cwd, outDir);
  await mkdir(dir, { recursive: true });
  const written: string[] = [];
  for (const [dbName, rows2] of Object.entries(data)) {
    const path = join(dir, `${dbName}.json`);
    await writeFile(path, `${JSON.stringify(rows2, null, 2)}\n`, 'utf8');
    written.push(path);
  }
  const index = `// 由 fsdt sample 生成，请勿手改。seed=${result.seed}\n${Object.keys(data)
    .map((dbName) => `export { default as ${dbName} } from './${dbName}.json';`)
    .join('\n')}\n`;
  await writeFile(join(dir, 'index.ts'), index, 'utf8');
  written.push(join(dir, 'index.ts'));

  ctx.io.stderr(`✓ seed=${result.seed}，${result.tables.length} 张表，每表 ${rows ?? 5} 行`);
  for (const path of written) ctx.io.stdout(rel(ctx.cwd, path));
  return EXIT_OK;
}
