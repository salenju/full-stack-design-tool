/**
 * dev 中间件的 API handler。
 *
 * 这里刻意不建 HTTP 框架：工作台只需要在 `vite dev` 时读写本机文件，
 * 起一个 NestJS 会引入 200MB 依赖和一层进程管理，收益为零。
 * 各端点直接调用 `@fsdt/*` 的库函数——和 CLI 走的是同一份实现，
 * 所以工作台里看到的编译结果、Lint 报告、生成产物与命令行逐字节一致。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, sep } from 'node:path';

import { emitOpenApi, serializeOpenApi, emitUiSchema } from '@fsdt/compiler';
import { coerceToIR, computeSchemaHash } from '@fsdt/core-ir';
import type { IR } from '@fsdt/core-ir';
import { exportCanvas, EXPORT_FORMATS } from '@fsdt/exporter';
import type { ExportFormat } from '@fsdt/exporter';
import { nestjsGenerator } from '@fsdt/generator-nestjs';
import { vueGenerator } from '@fsdt/generator-vue';
import type { CodeGenerator, FilePlan, RenderedFile } from '@fsdt/generators-runtime';
import { applyFixes, runLint } from '@fsdt/lint';
import type { LintResult } from '@fsdt/lint';

import { loadState, saveState, type WorkspaceInfo } from './workspace.js';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** 前端只允许拿到这几个目标的生成结果 */
const TARGETS: Record<string, { id: string; generator: CodeGenerator; subdir: string }> = {
  vue: { id: 'vue', generator: vueGenerator, subdir: 'frontend' },
  nestjs: { id: 'nestjs', generator: nestjsGenerator, subdir: 'backend' },
};

export interface GenFileView {
  path: string;
  kind: string;
  bytes: number;
  content: string;
}

export interface GenTargetView {
  id: string;
  subdir: string;
  files: GenFileView[];
}

function asIR(raw: unknown): IR {
  return coerceToIR(raw, '<request>');
}

function renderTarget(
  spec: { generator: CodeGenerator; id: string; subdir: string },
  ir: IR,
): Promise<RenderedFile[]> {
  const ctx = { projectName: ir.project.name, outputRoot: spec.subdir };
  return (async () => {
    const out: RenderedFile[] = [];
    for (const plan of spec.generator.plan(ir, ctx) as FilePlan[]) {
      out.push(await spec.generator.render(plan, ir, ctx));
    }
    return out;
  })();
}

export interface ApiContext {
  repoRoot: string;
  workspace: WorkspaceInfo;
}

// ────────────────────────────── 端点 ──────────────────────────────

export async function getState(ctx: ApiContext): Promise<unknown> {
  const state = await loadState(ctx.repoRoot);
  ctx.workspace = state.workspace;
  return {
    workspace: { root: state.workspace.root, irPath: state.workspace.irPath, mode: state.workspace.mode },
    ir: state.ir,
    schemaHash: state.schemaHash,
    bytes: state.bytes,
    exportFormats: EXPORT_FORMATS,
  };
}

export async function putIR(ctx: ApiContext, body: unknown): Promise<unknown> {
  const payload = body as { ir?: unknown };
  if (payload?.ir === undefined) throw new ApiError('缺少 ir 字段');
  const state = await loadState(ctx.repoRoot);
  const saved = await saveState(state.workspace, payload.ir);
  return { schemaHash: saved.schemaHash, bytes: saved.bytes, savedAt: new Date().toISOString() };
}

export async function postLint(_ctx: ApiContext, body: unknown): Promise<LintResult & { schemaHash: string }> {
  const ir = asIR((body as { ir?: unknown }).ir);
  // 与 CLI 一致：面板里也要能看到 IR00x，否则「gen 被拦但 Lint 全绿」无法解释
  const result = runLint(ir, { includeIRDiagnostics: true });
  return { ...result, schemaHash: computeSchemaHash(ir) };
}

export interface LintFixResponse {
  ir: IR;
  applied: Array<{ ruleId: string; message: string }>;
  skipped: Array<{ ruleId: string; message: string; reason: string }>;
}

/**
 * 一键修复。
 *
 * 在服务端算而不是前端算：修复会改 IR，而「改 IR 的唯一实现」在 @fsdt/lint 里，
 * 前端再实现一遍就有两份逻辑会漂移。前端只负责把返回的 IR 放进撤销栈。
 */
export async function postLintFix(_ctx: ApiContext, body: unknown): Promise<LintFixResponse> {
  const ir = asIR((body as { ir?: unknown }).ir);
  // 只拿可修的 L00x：IR00x 没有可执行修复（它们要求改结构，不是改命名）
  const outcome = applyFixes(ir, runLint(ir).issues);
  return {
    ir: outcome.ir,
    applied: outcome.applied.map((a) => ({ ruleId: a.issue.ruleId, message: a.issue.message })),
    skipped: outcome.skipped.map((s) => ({
      ruleId: s.issue.ruleId,
      message: s.issue.message,
      reason: s.reason,
    })),
  };
}

export async function postCompile(
  _ctx: ApiContext,
  body: unknown,
): Promise<{
  openapi: { json: unknown; yaml: string };
  uiSchema: { pages: unknown; enums: unknown };
  warnings: string[];
  schemaHash: string;
}> {
  const ir = asIR((body as { ir?: unknown }).ir);
  const openapi = emitOpenApi(ir);
  const ui = emitUiSchema(ir);
  return {
    openapi: {
      json: openapi.document,
      yaml: serializeOpenApi(openapi.document, { format: 'yaml' }),
    },
    uiSchema: { pages: ui.pages, enums: ui.enums },
    warnings: [...openapi.warnings, ...(ui.warnings ?? [])],
    schemaHash: computeSchemaHash(ir),
  };
}

export async function postGen(
  ctx: ApiContext,
  body: unknown,
): Promise<{ targets: GenTargetView[]; written: string[]; schemaHash: string }> {
  const payload = body as { ir?: unknown; targets?: string[]; write?: boolean };
  const ir = asIR(payload.ir);
  const wanted = payload.targets !== undefined && payload.targets.length > 0 ? payload.targets : ['vue', 'nestjs'];

  const views: GenTargetView[] = [];
  const written: string[] = [];

  for (const name of wanted) {
    const spec = TARGETS[name];
    if (spec === undefined) throw new ApiError(`未知目标：${name}，可选 ${Object.keys(TARGETS).join(' / ')}`);
    const files = await renderTarget(spec, ir);
    views.push({
      id: spec.id,
      subdir: spec.subdir,
      files: files.map((f) => ({
        path: `${spec.subdir}/${f.path}`,
        kind: f.kind,
        bytes: Buffer.byteLength(f.content),
        content: f.content,
      })),
    });

    if (payload.write === true) {
      for (const file of files) {
        const rel = normalize(join('output', spec.subdir, file.path));
        // 生成物的路径全部来自生成器，但仍要挡住 `..`：IR 里的 codeName 会进路径
        if (rel.startsWith('..') || rel.includes(`..${sep}`)) {
          throw new ApiError(`拒绝写入越界路径：${file.path}`);
        }
        const abs = join(ctx.workspace.root, rel);
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, file.content, 'utf8');
        written.push(rel.split(sep).join('/'));
      }
    }
  }

  return { targets: views, written, schemaHash: computeSchemaHash(ir) };
}

export async function postExport(
  _ctx: ApiContext,
  body: unknown,
): Promise<{ format: string; fileName: string; mimeType: string; content?: string; base64?: string }> {
  const payload = body as { ir?: unknown; format?: string; canvasId?: string };
  const ir = asIR(payload.ir);
  const format = (payload.format ?? 'svg') as ExportFormat;
  if (!EXPORT_FORMATS.includes(format)) {
    throw new ApiError(`不支持的导出格式：${String(payload.format)}`);
  }
  const canvasId = payload.canvasId ?? ir.canvases[0]?.id;
  if (canvasId === undefined) throw new ApiError('IR 里没有画布');

  const result = await exportCanvas(ir, canvasId, format, { includeNotes: true });
  return {
    format: result.format,
    fileName: result.fileName,
    mimeType: result.mimeType,
    ...(result.content !== undefined ? { content: result.content } : {}),
    ...(result.bytes !== undefined ? { base64: Buffer.from(result.bytes).toString('base64') } : {}),
  };
}
