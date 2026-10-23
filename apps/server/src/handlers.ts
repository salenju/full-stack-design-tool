/**
 * 服务模式的端点实现（TD 5.3）。
 *
 * 和 `apps/web/server` 的 dev 中间件是两套东西，不要合并：
 * - 工作台中间件跑在 vite 里，只管「当前这一个 design/ir.json」，是**文件模式**；
 * - 这里的服务跑在独立进程里，管多项目、快照、生成历史，是**服务模式**。
 *
 * 两边都直接调 `@fsdt/*` 的库函数，所以产物逐字节一致；共享的是库，不是传输层。
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';

import { emitOpenApi, emitUiSchema, serializeOpenApi } from '@fsdt/compiler';
import { computeSchemaHash, type IR } from '@fsdt/core-ir';
import { nestjsGenerator } from '@fsdt/generator-nestjs';
import { vueGenerator } from '@fsdt/generator-vue';
import {
  decideWrite,
  manifestEntryOf,
  type CodeGenerator,
  type Manifest,
  type ManifestFile,
  type RenderedFile,
} from '@fsdt/generators-runtime';
import { applyFixes, runLint } from '@fsdt/lint';

import { jobView, type JobRegistry } from './jobs.js';
import { NotFoundError, ValidationError, VersionConflictError, type ProjectStore } from './store.js';
import type { HttpResponse, RequestContext } from './router.js';
import { createZip, type ZipEntry } from './zip.js';

export const SERVER_VERSION = '0.1.0';

const TARGETS: Record<string, { id: string; generator: CodeGenerator; subdir: string }> = {
  vue: { id: 'vue', generator: vueGenerator, subdir: 'frontend' },
  nestjs: { id: 'nestjs', generator: nestjsGenerator, subdir: 'backend' },
};

export interface HandlerDeps {
  store: ProjectStore;
  jobs: JobRegistry;
}

/** 统一的错误视图：HTTP 层负责把它翻成状态码 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function json(status: number, body: unknown): HttpResponse {
  return { kind: 'json', status, body };
}

function asObject(body: unknown): Record<string, unknown> {
  return body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {};
}

function requireParam(ctx: RequestContext, name: string): string {
  const value = ctx.params[name];
  if (value === undefined || value.length === 0) throw new ApiError(`缺少路径参数 ${name}`, 400);
  return value;
}

/** If-Match 允许带引号（ETag 习惯写法），这里统一剥掉 */
function ifMatchOf(ctx: RequestContext): string | undefined {
  const raw = ctx.headers['if-match'];
  if (raw === undefined) return undefined;
  const value = Array.isArray(raw) ? raw[0]! : raw;
  return value.trim().replace(/^W\//, '').replace(/^"|"$/g, '');
}

// ────────────────────────────── 项目 ──────────────────────────────

export function listProjects(deps: HandlerDeps): HttpResponse {
  return json(200, { projects: deps.store.listProjects() });
}

export async function createProject(deps: HandlerDeps, ctx: RequestContext): Promise<HttpResponse> {
  const body = asObject(ctx.body);
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (name.length === 0) throw new ApiError('缺少项目名 name', 400);
  const project = await deps.store.createProject({ name });
  return json(201, { project });
}

export function getProject(deps: HandlerDeps, ctx: RequestContext): HttpResponse {
  const id = requireParam(ctx, 'id');
  const project = deps.store.getProject(id);
  return json(200, { project });
}

export async function deleteProject(deps: HandlerDeps, ctx: RequestContext): Promise<HttpResponse> {
  await deps.store.deleteProject(requireParam(ctx, 'id'));
  return json(200, { deleted: true });
}

// ────────────────────────────── IR 与画布 ──────────────────────────────

export async function getIr(deps: HandlerDeps, ctx: RequestContext): Promise<HttpResponse> {
  const id = requireParam(ctx, 'id');
  const canvas = ctx.query.get('canvas') ?? 'all';
  const { ir, schemaHash } = await deps.store.readIR(id);

  if (canvas === 'all') {
    return json(200, { ir, schemaHash, canvases: ir.canvases });
  }
  const doc = await deps.store.readCanvas(id, canvas);
  // 单画布视图也带 schemaHash：客户端拿它做 If-Match，写回时不用再读一次全量
  return json(200, { ...doc, schemaHash });
}

export async function putCanvas(deps: HandlerDeps, ctx: RequestContext): Promise<HttpResponse> {
  const id = requireParam(ctx, 'id');
  const canvasId = requireParam(ctx, 'canvasId');
  const expected = ifMatchOf(ctx);
  if (expected === undefined) {
    throw new ApiError('缺少 If-Match 头：写画布必须带上 GET 时拿到的 schemaHash', 428);
  }
  const result = await deps.store.writeCanvas(id, canvasId, ctx.body, expected);
  return json(200, result);
}

// ────────────────────────────── 快照 ──────────────────────────────

export function listSnapshots(deps: HandlerDeps, ctx: RequestContext): HttpResponse {
  return json(200, { snapshots: deps.store.listSnapshots(requireParam(ctx, 'id')) });
}

export async function createSnapshot(deps: HandlerDeps, ctx: RequestContext): Promise<HttpResponse> {
  const id = requireParam(ctx, 'id');
  const label = asObject(ctx.body).label;
  const snapshot = await deps.store.createSnapshot(id, typeof label === 'string' ? label : undefined);
  return json(201, { snapshot });
}

export async function restoreSnapshot(deps: HandlerDeps, ctx: RequestContext): Promise<HttpResponse> {
  const id = requireParam(ctx, 'id');
  const sid = requireParam(ctx, 'sid');
  const result = await deps.store.restoreSnapshot(id, sid);
  return json(200, { restored: true, schemaHash: result.schemaHash });
}

// ────────────────────────────── Lint / Compile ──────────────────────────────

export async function postLint(deps: HandlerDeps, ctx: RequestContext): Promise<HttpResponse> {
  const { ir, schemaHash } = await deps.store.readIR(requireParam(ctx, 'id'));
  // 与 CLI 一致：服务端报告也要含 IR00x，否则「gen 被拦但 Lint 全绿」无法解释
  const result = runLint(ir, { includeIRDiagnostics: true });
  return json(200, { ...result, schemaHash });
}

export async function postLintFix(deps: HandlerDeps, ctx: RequestContext): Promise<HttpResponse> {
  const id = requireParam(ctx, 'id');
  const { ir, schemaHash } = await deps.store.readIR(id);
  const outcome = applyFixes(ir, runLint(ir).issues);
  const fixed = outcome.ir;
  const expected = ifMatchOf(ctx) ?? schemaHash;
  // 修复会改 IR：走同一条写盘通路（乐观锁 + 校验），不另开一条旁路写盘。
  // 整份一次写入——逐个画布写的话，第一次写完 hash 就变了，第二次必然自己和自己冲突。
  const saved = await deps.store.writeIR(id, fixed, expected);
  return json(200, {
    schemaHash: saved.schemaHash,
    applied: outcome.applied.map((a) => ({ ruleId: a.issue.ruleId, message: a.issue.message })),
    skipped: outcome.skipped.map((s) => ({ ruleId: s.issue.ruleId, message: s.issue.message, reason: s.reason })),
  });
}

export async function postCompile(deps: HandlerDeps, ctx: RequestContext): Promise<HttpResponse> {
  const { ir, schemaHash } = await deps.store.readIR(requireParam(ctx, 'id'));
  const openapi = emitOpenApi(ir);
  const ui = emitUiSchema(ir);
  return json(200, {
    openapi: {
      json: openapi.document,
      yaml: serializeOpenApi(openapi.document, { format: 'yaml' }),
    },
    uiSchema: { pages: ui.pages, enums: ui.enums },
    warnings: [...openapi.warnings, ...(ui.warnings ?? [])],
    schemaHash,
  });
}

// ────────────────────────────── 生成 ──────────────────────────────

interface RenderedTarget {
  id: string;
  subdir: string;
  files: RenderedFile[];
}

function wantedTargets(raw: unknown): Array<{ id: string; generator: CodeGenerator; subdir: string }> {
  const names = Array.isArray(raw) && raw.length > 0 ? raw.map(String) : ['vue', 'nestjs'];
  return names.map((name) => {
    const spec = TARGETS[name];
    if (spec === undefined) throw new ApiError(`未知目标：${name}，可选 ${Object.keys(TARGETS).join(' / ')}`, 400);
    return spec;
  });
}

async function renderTargets(ir: IR, specs: Array<{ id: string; generator: CodeGenerator; subdir: string }>): Promise<RenderedTarget[]> {
  const out: RenderedTarget[] = [];
  for (const spec of specs) {
    const ctx = { projectName: ir.project.name, outputRoot: spec.subdir };
    const files: RenderedFile[] = [];
    for (const plan of spec.generator.plan(ir, ctx)) files.push(await spec.generator.render(plan, ir, ctx));
    out.push({ id: spec.id, subdir: spec.subdir, files });
  }
  return out;
}

export interface ManifestState {
  manifest?: Manifest;
  byPath: Map<string, ManifestFile>;
}

export async function readManifest(store: ProjectStore, projectId: string): Promise<ManifestState> {
  const path = join(store.projectDir(projectId), 'generated.manifest.json');
  if (!existsSync(path)) return { byPath: new Map() };
  try {
    const manifest = JSON.parse(await readFile(path, 'utf8')) as Manifest;
    return { manifest, byPath: new Map(manifest.files.map((f) => [f.path, f])) };
  } catch {
    // manifest 坏了按「无历史」处理：宁可全量重算，也不要让生成直接失败
    return { byPath: new Map() };
  }
}

interface FileDecisionView {
  path: string;
  action: string;
  reasons?: string[];
}

/**
 * 预览：只算「会怎么变」，不写盘。
 *
 * 与 `fsdt gen` 不带 `--out` 的语义一致——工作台上点「预览」不该产生任何副作用。
 */
export async function postGeneratePreview(
  deps: HandlerDeps,
  ctx: RequestContext,
): Promise<HttpResponse> {
  const id = requireParam(ctx, 'id');
  const body = asObject(ctx.body);
  const { ir, schemaHash } = await deps.store.readIR(id);
  const specs = wantedTargets(body.targets);
  const rendered = await renderTargets(ir, specs);
  const manifest = await readManifest(deps.store, id);
  const outputRoot = deps.store.outputDir(id);

  const files: FileDecisionView[] = [];
  for (const target of rendered) {
    for (const file of target.files) {
      const rel = posix.join(target.subdir, file.path);
      const abs = join(outputRoot, rel);
      const existing = existsSync(abs) ? await readFile(abs, 'utf8') : undefined;
      const decision =
        existing === undefined
          ? { action: 'write', reasons: [] as string[] }
          : decideWrite(file, existing, manifest.byPath.get(rel), Boolean(body.force));
      files.push({
        path: rel,
        action: existing === undefined ? 'added' : decision.action,
        ...(decision.reasons.length > 0 ? { reasons: decision.reasons } : {}),
      });
    }
  }
  return json(200, { files, schemaHash });
}

/**
 * 执行生成（异步任务 + SSE 进度）。
 *
 * 同一项目同一时刻只允许一个生成任务：两个任务并行写 output/ 会让 manifest 互相覆盖，
 * 结果是「谁后写完谁说了算」，而两边的 outputs 可能都不完整。
 */
export async function postGenerate(deps: HandlerDeps, ctx: RequestContext): Promise<HttpResponse> {
  const id = requireParam(ctx, 'id');
  const body = asObject(ctx.body);
  const project = deps.store.getProject(id);

  const running = deps.jobs.running(id, 'generate');
  if (running !== undefined) {
    return json(409, { error: '该项目已有生成任务在跑', jobId: running.id });
  }

  const specs = wantedTargets(body.targets);
  const force = Boolean(body.force);
  const skipVerify = Boolean(body.skipVerify);
  const job = deps.jobs.create('generate', id);

  // 不 await：HTTP 立即返回 jobId，进度走 SSE。错误在这里收敛成 job.error，
  // 否则会成为未处理的 rejection 把进程带崩。
  void runGenerate(deps, job.id, id, project.name, specs, { force, skipVerify }).catch((error: unknown) => {
    deps.jobs.fail(job.id, error instanceof Error ? error.message : String(error));
  });

  return json(202, { jobId: job.id });
}

async function runGenerate(
  deps: HandlerDeps,
  jobId: string,
  projectId: string,
  projectName: string,
  specs: Array<{ id: string; generator: CodeGenerator; subdir: string }>,
  options: { force: boolean; skipVerify: boolean },
): Promise<void> {
  deps.jobs.progress(jobId, { step: 'read-ir', percent: 5 });
  const { ir, schemaHash } = await deps.store.readIR(projectId);

  if (!options.skipVerify) {
    deps.jobs.progress(jobId, { step: 'verify', percent: 15 });
    const problems = runLint(ir, { includeIRDiagnostics: true })
      .issues.filter((issue) => issue.severity === 'error')
      .map((issue) => `[${issue.ruleId}] ${issue.message}`);
    if (problems.length > 0) {
      throw new ApiError(`IR 未通过校验（${problems.length} 个错误），已中止生成`, 422, { problems });
    }
  }

  const outputRoot = deps.store.outputDir(projectId);
  const manifest = await readManifest(deps.store, projectId);
  const generationId = `gen_${Date.now().toString(36)}_${schemaHash.slice(-6)}`;

  const written: string[] = [];
  const merged: string[] = [];
  const unchanged: string[] = [];
  const conflicted: string[] = [];
  const conflictReasons: Record<string, string[]> = {};
  const manifestFiles: ManifestFile[] = [];

  const stepPercent = 20;
  for (let i = 0; i < specs.length; i += 1) {
    const spec = specs[i]!;
    deps.jobs.progress(jobId, { step: `render:${spec.id}`, percent: stepPercent + Math.round((i / specs.length) * 50) });
    const rendered = await renderTargets(ir, [spec]);
    const files = rendered[0]?.files ?? [];

    for (const file of files) {
      const rel = posix.join(spec.subdir, file.path);
      manifestFiles.push(manifestEntryOf(file, rel));
      const abs = join(outputRoot, rel);
      const existing = existsSync(abs) ? await readFile(abs, 'utf8') : undefined;
      const decision =
        existing === undefined
          ? { action: 'write' as const, content: file.content, reasons: [] as string[] }
          : decideWrite(file, existing, manifest.byPath.get(rel), options.force);

      switch (decision.action) {
        case 'unchanged':
          unchanged.push(rel);
          break;
        case 'merged':
          await writeOut(abs, decision.content);
          merged.push(rel);
          break;
        case 'conflict':
          conflicted.push(rel);
          conflictReasons[rel] = decision.reasons;
          break;
        default:
          await writeOut(abs, decision.content);
          written.push(rel);
      }
    }
  }

  deps.jobs.progress(jobId, { step: 'manifest', percent: 80 });
  const nextManifest: Manifest = {
    manifestVersion: 1,
    generationId,
    schemaHash,
    files: manifestFiles.sort((a, b) => (a.path < b.path ? -1 : 1)),
    createdAt: ir.meta.updatedAt,
    generator: Object.fromEntries(specs.map((s) => [s.id, s.generator.version])),
    warnings: [],
  };
  const projectDir = deps.store.projectDir(projectId);
  await writeOut(join(projectDir, 'generated.manifest.json'), `${JSON.stringify(nextManifest, null, 2)}\n`);

  // 生成历史：把本次 output 整棵拷进 generations/<gid>，manifest 一起留档。
  // 有它才能回答「上周能跑的那版产物长什么样」——这也是回滚产物的唯一凭据。
  deps.jobs.progress(jobId, { step: 'archive', percent: 90 });
  const archiveDir = deps.store.generationDir(projectId, generationId);
  const { cp } = await import('node:fs/promises');
  if (existsSync(outputRoot)) {
    await cp(outputRoot, join(archiveDir, 'files'), { recursive: true });
  } else {
    await mkdir(archiveDir, { recursive: true });
  }
  await writeOut(join(archiveDir, 'manifest.json'), `${JSON.stringify(nextManifest, null, 2)}\n`);

  deps.jobs.done(jobId, {
    generationId,
    projectName,
    schemaHash,
    outputRoot: 'output',
    written: written.length,
    merged: merged.length,
    unchanged: unchanged.length,
    conflicted: conflicted.length,
    conflictReasons,
  });
}

async function writeOut(abs: string, content: string): Promise<void> {
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf8');
}

export function getJob(deps: HandlerDeps, ctx: RequestContext): HttpResponse {
  return json(200, { job: jobView(deps.jobs.get(requireParam(ctx, 'jobId'))) });
}

/** SSE：连上先补历史，再推实时事件；任务已结束则补完即关闭 */
export function jobEvents(deps: HandlerDeps, ctx: RequestContext): HttpResponse {
  const jobId = requireParam(ctx, 'jobId');
  const job = deps.jobs.get(jobId);
  const from = Number(ctx.query.get('from') ?? '0');

  return {
    kind: 'sse',
    run: (send, close) => {
      const terminal = (state: string): boolean => state === 'done' || state === 'error';
      const unsubscribe = deps.jobs.subscribe(
        jobId,
        (event) => {
          send(event.type, event);
          if (terminal(deps.jobs.get(jobId).state) && event.type !== 'job.progress') close();
        },
        Number.isFinite(from) ? from : 0,
      );
      // 订阅时任务已经结束：历史补完就关，否则客户端会一直挂着等一个永远不来的事件
      if (terminal(job.state)) {
        unsubscribe();
        close();
      }
      return unsubscribe;
    },
  };
}

// ────────────────────────────── 下载 ──────────────────────────────

/**
 * 打包下载。
 *
 * 默认打最近一次生成（output/），也可以指定 `?gen=<gid>` 打历史某一版。
 * 文件名用项目名，但 Content-Disposition 同时给 ASCII 兜底与 `filename*`。
 */
export async function download(deps: HandlerDeps, ctx: RequestContext): Promise<HttpResponse> {
  const id = requireParam(ctx, 'id');
  const project = deps.store.getProject(id);
  const gen = ctx.query.get('gen');

  const root = gen === null ? deps.store.outputDir(id) : join(deps.store.generationDir(id, gen), 'files');
  if (!existsSync(root)) {
    throw new NotFoundError(`没有可下载的产物：${gen === null ? 'output/' : `generations/${gen}/files`}（先跑一次生成）`);
  }

  const entries = await collectFiles(root);
  const zip = createZip(entries);
  const asciiName = project.name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'project';
  const fileName = `${asciiName}-${gen ?? 'latest'}.zip`;
  return {
    kind: 'binary',
    status: 200,
    body: zip,
    contentType: 'application/zip',
    fileName,
  };
}

async function collectFiles(root: string, prefix = ''): Promise<ZipEntry[]> {
  const out: ZipEntry[] = [];
  const items = await readdir(root, { withFileTypes: true });
  for (const item of items.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const abs = join(root, item.name);
    const rel = prefix.length === 0 ? item.name : `${prefix}/${item.name}`;
    if (item.isDirectory()) {
      out.push(...(await collectFiles(abs, rel)));
    } else {
      out.push({ path: rel, data: await readFile(abs) });
    }
  }
  return out;
}

// ────────────────────────────── 健康检查 ──────────────────────────────

export function health(deps: HandlerDeps): HttpResponse {
  return json(200, {
    ok: true,
    version: SERVER_VERSION,
    home: deps.store.home,
    projects: deps.store.listProjects().length,
  });
}

/** 把领域错误翻成 HTTP 状态码，集中在这里，避免每个 handler 各写一遍 */
export function toHttpError(error: unknown): { status: number; body: unknown } | undefined {
  if (error instanceof VersionConflictError) {
    const missing = error.expected === '<missing>';
    return {
      status: missing ? 428 : 409,
      body: {
        error: missing ? '缺少 If-Match 头' : '版本冲突：画布已被他人修改',
        expected: error.expected,
        latestHash: error.latestHash,
      },
    };
  }
  if (error instanceof NotFoundError) return { status: 404, body: { error: error.message } };
  if (error instanceof ValidationError) {
    return { status: 422, body: { error: error.message, problems: error.problems } };
  }
  if (error instanceof ApiError) {
    return {
      status: error.status,
      body: { error: error.message, ...(error.detail !== undefined ? { detail: error.detail } : {}) },
    };
  }
  return undefined;
}
