/**
 * `fsdt sample`：生成示例数据并落成 mock 文件。
 *
 * 默认输出的是**可直接被 MSW / mock 服务器读的 JSON**，而不是一张大表：
 * 一个文件一张表，前端可以按需 import，也让「哪张表的数据变了」在 git 里看得清。
 */

import { generateSamples, toHttpFile, toPostmanCollection, toSeedJson, toSeedSql } from '@fsdt/sample';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { flagList, flagString, rejectUnknown, type ParsedArgs } from '../args.js';
import type { CommandContext } from '../context.js';
import { EXIT_OK, UsageError, rel } from '../io.js';
import { findIr, loadIrFrom } from '../ir-source.js';

const ALLOWED = ['ir', 'out', 'seed', 'count', 'rows', 'mask', 'format', 'base-url', 'help'];

type SampleFormat = 'json' | 'http' | 'postman' | 'sql';
const FORMATS: SampleFormat[] = ['json', 'http', 'postman', 'sql'];

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

  const requested = flagList(args, 'format');
  const formats: SampleFormat[] = requested.length === 0 ? ['json'] : (requested as SampleFormat[]);
  const bad = formats.filter((f) => !FORMATS.includes(f));
  if (bad.length > 0) {
    throw new UsageError(`--format 只支持 ${FORMATS.join(' | ')}，收到：${bad.join(', ')}`);
  }
  const baseUrl = flagString(args, 'base-url');
  const exportOptions = baseUrl !== undefined ? { baseUrl } : {};

  const outDir = flagString(args, 'out');
  if (outDir === undefined) {
    // stdout 只能承载一种格式，否则 JSON 和 SQL 混在一起没法用
    if (formats.length > 1) {
      throw new UsageError('多种 --format 必须配合 --out 写盘；输出到终端时一次只能用一种格式。');
    }
    const only = formats[0] ?? 'json';
    if (only === 'json') ctx.io.stdout(JSON.stringify(toSeedJson(ir, result), null, 2));
    else if (only === 'http') ctx.io.stdout(toHttpFile(ir, result, exportOptions));
    else if (only === 'sql') ctx.io.stdout(toSeedSql(ir, result));
    else ctx.io.stdout(JSON.stringify(toPostmanCollection(ir, result, exportOptions), null, 2));
    return EXIT_OK;
  }

  const dir = join(ctx.cwd, outDir);
  await mkdir(dir, { recursive: true });
  const written: string[] = [];

  if (formats.includes('json')) {
    const data = toSeedJson(ir, result);
    for (const [dbName, tableRows] of Object.entries(data)) {
      const path = join(dir, `${dbName}.json`);
      await writeFile(path, `${JSON.stringify(tableRows, null, 2)}\n`, 'utf8');
      written.push(path);
    }
    const index = `// 由 fsdt sample 生成，请勿手改。seed=${result.seed}\n${Object.keys(data)
      .map((dbName) => `export { default as ${dbName} } from './${dbName}.json';`)
      .join('\n')}\n`;
    await writeFile(join(dir, 'index.ts'), index, 'utf8');
    written.push(join(dir, 'index.ts'));
  }

  if (formats.includes('http')) {
    const path = join(dir, 'api-samples.http');
    await writeFile(path, toHttpFile(ir, result, exportOptions), 'utf8');
    written.push(path);
  }

  if (formats.includes('postman')) {
    const path = join(dir, 'postman-collection.json');
    await writeFile(path, `${JSON.stringify(toPostmanCollection(ir, result, exportOptions), null, 2)}\n`, 'utf8');
    written.push(path);
  }

  if (formats.includes('sql')) {
    const path = join(dir, 'seed.sql');
    await writeFile(path, toSeedSql(ir, result), 'utf8');
    written.push(path);
  }

  ctx.io.stderr(`✓ seed=${result.seed}，${result.tables.length} 张表，每表 ${rows ?? 5} 行`);
  ctx.io.stderr(`  格式：${formats.join(' / ')}`);
  for (const path of written) ctx.io.stdout(rel(ctx.cwd, path));
  return EXIT_OK;
}
