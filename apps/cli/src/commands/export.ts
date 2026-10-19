/**
 * `fsdt export`：把画布导出成图片 / 图结构文件。
 *
 * 与 `gen` 的关键区别：**导出物不进 git 的漂移门禁**。图是给人看的，
 * 重新导出的时机由人决定；一旦纳入门禁，每次挪一个节点都会让 CI 红灯。
 * 所以这里没有 `--check`。
 */

import { EXPORT_FORMATS, exportCanvas, type ExportFormat } from '@fsdt/exporter';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { flagBool, flagString, rejectUnknown, type ParsedArgs } from '../args.js';
import type { CommandContext } from '../context.js';
import { EXIT_OK, UsageError, humanBytes, rel, writeText } from '../io.js';
import { findIr, loadIrFrom } from '../ir-source.js';

const ALLOWED = ['ir', 'out', 'format', 'canvas', 'scale', 'theme', 'notes', 'ports', 'help'];

function parseFormat(raw: string | undefined): ExportFormat[] {
  if (raw === undefined) return ['svg'];
  const list = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  const out: ExportFormat[] = [];
  for (const item of list) {
    if (!(EXPORT_FORMATS as string[]).includes(item)) {
      throw new UsageError(`--format 只支持 ${EXPORT_FORMATS.join(' | ')}，收到：${item}`);
    }
    out.push(item as ExportFormat);
  }
  return out;
}

export async function runExportCommand(args: ParsedArgs, ctx: CommandContext): Promise<number> {
  const unknown = rejectUnknown(args, ALLOWED);
  if (unknown.length > 0) throw new UsageError(unknown.join('\n'));

  const formats = parseFormat(flagString(args, 'format'));
  const theme = flagString(args, 'theme') ?? 'light';
  if (theme !== 'light' && theme !== 'dark') throw new UsageError(`--theme 只支持 light | dark，收到：${theme}`);
  const scaleText = flagString(args, 'scale');
  const scale = scaleText === undefined ? 2 : Number(scaleText);
  if (!Number.isFinite(scale) || scale <= 0) throw new UsageError(`--scale 必须是正数，收到：${scaleText}`);

  // 二进制格式必须先校验输出目录再干活：png 要走 resvg 光栅化（几百毫秒到数秒），
  // 先渲染再发现「没有 --out」既浪费又会让用户以为命令卡住了。
  const outDir = flagString(args, 'out');
  const BINARY: ExportFormat[] = ['png'];
  const binaryWanted = formats.filter((f) => BINARY.includes(f));
  if (outDir === undefined && binaryWanted.length > 0) {
    throw new UsageError(`导出 ${binaryWanted.join('/')} 需要 --out <dir>（二进制内容不能写到终端）`);
  }

  const source = findIr(ctx.cwd, flagString(args, 'ir'));
  const { ir } = await loadIrFrom(source);

  // 不指定画布时导出全部：用户说「导出这个设计」通常指整份设计，而不是第一个画布
  const wanted = flagString(args, 'canvas');
  const canvases = wanted === undefined ? ir.canvases : ir.canvases.filter((c) => c.id === wanted || c.name === wanted);
  if (canvases.length === 0) throw new UsageError(`找不到画布：${wanted}`);

  for (const canvas of canvases) {
    for (const format of formats) {
      const result = await exportCanvas(ir, canvas.id, format, {
        theme,
        scale,
        includeNotes: flagBool(args, 'notes'),
        includeFieldPorts: flagBool(args, 'ports'),
      });
      if (outDir === undefined) {
        // 走到这里 format 一定是文本类（二进制在前面已拦下）
        ctx.io.stdout(`--- ${canvas.name} → ${result.fileName} ---`);
        ctx.io.stdout(result.content ?? '');
        continue;
      }
      const dir = join(ctx.cwd, outDir);
      const path = join(dir, result.fileName);
      if (result.bytes !== undefined) {
        // 二进制要先建目录再写；先调 writeText 会写一个空文件、把 PNG 头破坏掉
        await mkdir(dir, { recursive: true });
        await writeFile(path, result.bytes);
        ctx.io.stderr(`✓ ${rel(ctx.cwd, path)}（${humanBytes(result.bytes.byteLength)}）`);
      } else {
        await writeText(path, result.content ?? '');
        ctx.io.stderr(`✓ ${rel(ctx.cwd, path)}`);
      }
    }
  }
  return EXIT_OK;
}
