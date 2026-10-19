/**
 * `fsdt compile`：IR → OpenAPI / UI Schema / 示例数据 / lint 报告。
 *
 * 这是「AI agent 工具面」的主入口（TD 16.1 第 3 条）：
 * `fsdt compile --stdout json` 一次调用就能把整个设计的结构交付给 agent，
 * 无需先实现 MCP 协议。因此 `--stdout json` 的输出必须**自包含且稳定**。
 *
 * 默认只读：不给 `--out` 就把结果打到 stdout，绝不写盘。
 */

import { emitOpenApi, emitUiSchema, serializeOpenApi } from '@fsdt/compiler';
import { generateSamples, toSeedJson } from '@fsdt/sample';
import { runLint } from '@fsdt/lint';
import { flagBool, flagString, rejectUnknown, type ParsedArgs } from '../args.js';
import type { CommandContext } from '../context.js';
import { EXIT_OK, EXIT_USAGE, UsageError, humanBytes, rel, writeText } from '../io.js';
import { findIr, loadIrFrom } from '../ir-source.js';
import { join } from 'node:path';

const ALLOWED = ['ir', 'out', 'format', 'seed', 'rows', 'stdout', 'no-samples', 'help'];

export interface CompileBundle {
  openapi: { document: unknown; warnings: string[] };
  uiSchema: { pages: unknown[]; warnings: string[] };
  samples?: { tables: unknown[]; seed: number; warnings: string[] };
  lint: { issues: unknown[]; stats: unknown };
}

export async function runCompileCommand(args: ParsedArgs, ctx: CommandContext): Promise<number> {
  const unknown = rejectUnknown(args, ALLOWED);
  if (unknown.length > 0) throw new UsageError(unknown.join('\n'));

  const format = flagString(args, 'format') ?? 'yaml';
  if (!['yaml', 'json'].includes(format)) throw new UsageError(`--format 只支持 yaml | json，收到：${format}`);
  const seedText = flagString(args, 'seed');
  const seed = seedText === undefined ? undefined : Number(seedText);
  if (seed !== undefined && !Number.isFinite(seed)) throw new UsageError(`--seed 必须是数字，收到：${seedText}`);
  const rowsText = flagString(args, 'rows');
  const rows = rowsText === undefined ? undefined : Number(rowsText);
  if (rows !== undefined && (!Number.isInteger(rows) || rows < 1)) {
    throw new UsageError(`--rows 必须是正整数，收到：${rowsText}`);
  }

  const source = findIr(ctx.cwd, flagString(args, 'ir'));
  const { ir } = await loadIrFrom(source);

  const openapi = emitOpenApi(ir);
  const uiSchema = emitUiSchema(ir);
  const lint = runLint(ir);
  const withSamples = !flagBool(args, 'no-samples');
  const samples = withSamples
    ? generateSamples(ir, {
        ...(seed !== undefined ? { seed } : {}),
        ...(rows !== undefined ? { rowsPerTable: rows } : {}),
      })
    : undefined;

  const warnings = [...openapi.warnings, ...uiSchema.warnings, ...(samples?.warnings ?? [])];
  for (const w of warnings) ctx.io.stderr(`⚠ ${w}`);

  if (flagBool(args, 'stdout')) {
    const bundle: CompileBundle = {
      openapi: { document: openapi.document, warnings: openapi.warnings },
      uiSchema: { pages: uiSchema.pages, warnings: uiSchema.warnings },
      ...(samples !== undefined ? { samples: { tables: samples.tables, seed: samples.seed, warnings: samples.warnings } } : {}),
      lint: { issues: lint.issues, stats: lint.stats },
    };
    ctx.io.stdout(JSON.stringify(bundle, null, 2));
    return EXIT_OK;
  }

  const outDir = flagString(args, 'out');
  if (outDir === undefined) {
    // 默认只读：没有 --out 就把主产物打到 stdout，而不是悄悄写到当前目录
    ctx.io.stdout(serializeOpenApi(openapi.document, { format: format as 'yaml' | 'json' }));
    if (samples !== undefined) ctx.io.stderr(`（示例数据 ${samples.tables.length} 张表未输出，加 --stdout json 可一并获取）`);
    return EXIT_OK;
  }

  const dir = join(ctx.cwd, outDir);
  const written: Array<{ path: string; bytes: number }> = [];
  const openapiText = serializeOpenApi(openapi.document, { format: format as 'yaml' | 'json' });
  const openapiPath = join(dir, format === 'json' ? 'openapi.json' : 'openapi.yaml');
  await writeText(openapiPath, openapiText);
  written.push({ path: openapiPath, bytes: Buffer.byteLength(openapiText) });

  const uiText = `${JSON.stringify({ pages: uiSchema.pages }, null, 2)}\n`;
  const uiPath = join(dir, 'ui-schema.json');
  await writeText(uiPath, uiText);
  written.push({ path: uiPath, bytes: Buffer.byteLength(uiText) });

  if (samples !== undefined) {
    const seedText2 = `${JSON.stringify(toSeedJson(ir, samples), null, 2)}\n`;
    const seedPath = join(dir, 'seed.json');
    await writeText(seedPath, seedText2);
    written.push({ path: seedPath, bytes: Buffer.byteLength(seedText2) });
  }

  for (const file of written) {
    ctx.io.stderr(`✓ ${rel(ctx.cwd, file.path)}（${humanBytes(file.bytes)}）`);
  }
  return EXIT_OK;
}
