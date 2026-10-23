/**
 * `fsdt gen`：IR → 代码（Vue 前端 / NestJS 后端）。
 *
 * 这是整个工具里唯一「会写很多文件」的命令，因此纪律最严：
 *
 * 1. **默认只读**：没有 `--out` 就只预览（列出将写哪些文件），不落盘。
 * 2. **`--check` 与 `--out` 互斥**：`--check` 是 CI 门禁（漂移检测），
 *    语义是「报告差异并以非零退出」，绝不能顺手把差异写掉——
 *    否则 CI 永远绿，因为它自己把漂移修好了。
 * 3. **覆盖前先比对 manifest**：用户手改过的文件不覆盖。但「不覆盖」不够用——
 *    用户真正要的是「我实现的 service 方法、我写的页面逻辑，重新生成后还在」。
 *    所以手改文件会先尝试区块级三方合并（见 runtime 的 `mergeRegions`）：
 *    合并得动就写合并结果，合不动的才报冲突，`--force` 强行覆盖。
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { bareHash, computeSchemaHash, hashContent, validateIR } from '@fsdt/core-ir';
import type { IR } from '@fsdt/core-ir';
import { vueGenerator, GENERATOR_ID as VUE_ID, GENERATOR_VERSION as VUE_VERSION } from '@fsdt/generator-vue';
import { nestjsGenerator, GENERATOR_ID as NEST_ID, GENERATOR_VERSION as NEST_VERSION } from '@fsdt/generator-nestjs';
import { mergeRegions, regionsOf } from '@fsdt/generators-runtime';
import type { CodeGenerator, Manifest, ManifestFile, RenderedFile } from '@fsdt/generators-runtime';
import { runLint } from '@fsdt/lint';
import { flagBool, flagList, flagString, rejectUnknown, type ParsedArgs } from '../args.js';
import type { CommandContext } from '../context.js';
import { EXIT_FAIL, EXIT_OK, UsageError, rel, writeText } from '../io.js';
import { findIr, loadIrFrom, manifestPathOf, type IrSource } from '../ir-source.js';

const ALLOWED = ['ir', 'out', 'target', 'check', 'force', 'skip-verify', 'help'];

export interface TargetSpec {
  id: string;
  generator: CodeGenerator;
  /** 输出子目录，避免两个生成器把文件写到同一层 */
  subdir: string;
}

/**
 * 目标注册表。
 *
 * 子目录是刻意的：前端与后端会各产出一份 `package.json`，
 * 放同一目录必然互相覆盖，而「哪一份被覆盖了」在生成日志里看不出来。
 */
export const TARGETS: Record<string, TargetSpec> = {
  vue: { id: VUE_ID, generator: vueGenerator, subdir: 'frontend' },
  nestjs: { id: NEST_ID, generator: nestjsGenerator, subdir: 'backend' },
};

/**
 * 把输出目录规范成「相对项目根、POSIX 分隔符」的形式写进 manifest。
 *
 * 之所以不存绝对路径：manifest 要提交进仓库，绝对路径在别人的机器上必然失效。
 * 之所以不存相对 cwd：CI 与本地可能在不同子目录执行同一命令。
 */
export function relativeOutputRoot(projectRoot: string, outDir: string): string {
  const abs = join(projectRoot, outDir);
  const relPath = abs.slice(projectRoot.length).replace(/^[/\\]/, '').split('\\').join('/');
  return relPath;
}

export function resolveTargets(names: string[]): TargetSpec[] {
  const wanted = names.length > 0 ? names : ['vue', 'nestjs'];
  const out: TargetSpec[] = [];
  for (const name of wanted) {
    const spec = TARGETS[name];
    if (spec === undefined) {
      throw new UsageError(`--target 只支持 ${Object.keys(TARGETS).join(' | ')}，收到：${name}`);
    }
    out.push(spec);
  }
  return out;
}

async function renderTarget(spec: TargetSpec, ir: IR, projectRoot: string): Promise<RenderedFile[]> {
  const ctx = { projectName: ir.project.name, outputRoot: projectRoot };
  const files: RenderedFile[] = [];
  for (const plan of spec.generator.plan(ir, ctx)) {
    files.push(await spec.generator.render(plan, ir, ctx));
  }
  return files;
}

/**
 * manifest 条目。
 *
 * 存的必须是**纯净生成内容**（`file.content`）的哈希，不能是合并后的磁盘内容：
 * 合并结果里含用户手写部分，一旦记成基线，下次生成就会认为「没人改过」，
 * 直接覆盖——todo 区块里的实现当场丢失。
 */
function manifestEntry(file: RenderedFile, manifestPath: string): ManifestFile {
  const parsed = regionsOf(file.content);
  return {
    path: manifestPath,
    hash: hashContent(file.content),
    kind: file.kind,
    sourceNodeIds: file.sourceNodeIds,
    overwrite: file.overwrite,
    regions:
      parsed.length > 0
        ? parsed
        : file.regions.map((r) => ({ name: r.name, mode: r.mode, hash: r.hash })),
  };
}

interface WriteDecision {
  action: 'write' | 'merged' | 'unchanged' | 'conflict';
  content: string;
  /** 冲突原因，写进 stderr 让人知道该改哪里 */
  reasons: string[];
}

/**
 * 决定一个已存在的文件该怎么处理。
 *
 * 优先级：内容相同 → 跳过；`--force` → 覆盖；`never` → 不碰；
 * 没被改过 → 覆盖；被改过 → 尝试区块合并，合不动才报冲突。
 */
export function resolveWrite(
  file: RenderedFile,
  existing: string,
  previous: ManifestFile | undefined,
  force: boolean,
): WriteDecision {
  if (existing === file.content) return { action: 'unchanged', content: existing, reasons: [] };
  if (force) return { action: 'write', content: file.content, reasons: [] };
  if (file.overwrite === 'never') {
    return { action: 'conflict', content: existing, reasons: ['文件标记为不可覆盖（只在不存在时写入）'] };
  }

  const handEdited = previous !== undefined && hashContent(existing) !== previous.hash;
  if (file.overwrite === 'always' || !handEdited) {
    return { action: 'write', content: file.content, reasons: [] };
  }

  const merged = mergeRegions(file.content, existing, previous?.regions ?? []);
  if (merged.status === 'merged') return { action: 'merged', content: merged.content, reasons: [] };
  if (merged.status === 'unchanged') return { action: 'unchanged', content: existing, reasons: [] };
  if (merged.status === 'unmergeable') {
    return {
      action: 'conflict',
      content: existing,
      reasons: ['文件里没有 @dsg 区块标记，无法判断哪些是手写内容'],
    };
  }
  return { action: 'conflict', content: existing, reasons: merged.conflicts.map(describeConflict) };
}

function describeConflict(conflict: { region: string; reason: string }): string {
  if (conflict.reason === 'removed-region') return `区块 ${conflict.region}：磁盘上有，但本次生成不再产出`;
  return `区块 ${conflict.region}：生成的内容被手工改过，无法自动抉择`;
}

export interface GenOutcome {
  /** 计划写但未写的文件（预览） */
  planned: string[];
  written: string[];
  /** 内容与磁盘一致，无需重写 */
  unchanged: string[];
  /** 手改过、但区块合并成功（手写内容保住，骨架更新） */
  merged: string[];
  /** 合并也救不了，跳过覆盖 */
  conflicted: string[];
  /** 每个冲突文件的原因 */
  conflictReasons: Record<string, string[]>;
  /** --check 模式下与磁盘不一致的文件 */
  drifted: string[];
}

export function emptyOutcome(): GenOutcome {
  return { planned: [], written: [], unchanged: [], merged: [], conflicted: [], conflictReasons: {}, drifted: [] };
}

export function summarize(stacks: Array<{ spec: TargetSpec; outcome: GenOutcome }>): string {
  const lines: string[] = [];
  let totalWritten = 0;
  let totalConflicted = 0;
  let totalMerged = 0;
  for (const { spec, outcome } of stacks) {
    const mergedPart = outcome.merged.length > 0 ? `，合并 ${outcome.merged.length}` : '';
    lines.push(
      `\n[${spec.id}] 新增/更新 ${outcome.written.length}，未变 ${outcome.unchanged.length}${mergedPart}，冲突 ${outcome.conflicted.length}`,
    );
    totalWritten += outcome.written.length;
    totalConflicted += outcome.conflicted.length;
    totalMerged += outcome.merged.length;
  }
  lines.push(
    `\n合计：写入 ${totalWritten} 个文件` +
      (totalMerged > 0 ? `，${totalMerged} 个文件在原位合并（手写区块保留）` : '') +
      (totalConflicted > 0 ? `，${totalConflicted} 个文件因手改被跳过（用 --force 覆盖）` : ''),
  );
  return `${lines.join('\n')}\n`;
}

/**
 * 生成前该拦下的问题：IR 语义错误（IR00x）+ error 级契约规则。
 *
 * 只拦 error 不拦 warn：存量 warn 清不完的项目会被永久卡住，用户只能天天加
 * `--skip-verify`，门禁等于不存在。error 才是「生成出来必然是错的」那一档。
 */
function collectBlockingProblems(ir: IR): string[] {
  // includeIRDiagnostics 让 Lint 顺带把 IR00x 报出来，这里不必再单独跑一遍 validateIR
  return runLint(ir, { includeIRDiagnostics: true })
    .issues.filter((issue) => issue.severity === 'error')
    .map((issue) => `[${issue.ruleId}] ${issue.message}`);
}

export async function runGenCommand(args: ParsedArgs, ctx: CommandContext): Promise<number> {
  const unknown = rejectUnknown(args, ALLOWED);
  if (unknown.length > 0) throw new UsageError(unknown.join('\n'));

  const check = flagBool(args, 'check');
  const out = flagString(args, 'out');
  const force = flagBool(args, 'force');
  // 纪律 2：--check 与 --out 互斥。两者同时给说明用户没想清楚要做什么，
  // 而任何一种猜测都可能造成「CI 自己把漂移修掉了」。
  if (check && out !== undefined) {
    throw new UsageError('--check 与 --out 互斥：前者只报告差异、不写盘，后者用于实际生成。');
  }

  const source = findIr(ctx.cwd, flagString(args, 'ir'));
  const { ir } = await loadIrFrom(source);

  // 门禁：读文件只做了 Zod 结构校验（IR000），语义错误（IR002 之类的 ID 重复、
  // 悬空外键）和 Lint 的 error 级问题都不会被 loadIR 拦住。曾经因此把一份
  // 18 处字段 ID 重复的 IR 一路生成出 31 个文件。
  if (!flagBool(args, 'skip-verify')) {
    const problems = collectBlockingProblems(ir);
    if (problems.length > 0) {
      ctx.io.stderr(`✗ IR 未通过校验（${problems.length} 个错误），已中止生成：`);
      for (const line of problems.slice(0, 12)) ctx.io.stderr(`  • ${line}`);
      if (problems.length > 12) ctx.io.stderr(`  …另有 ${problems.length - 12} 个`);
      ctx.io.stderr('');
      ctx.io.stderr('先跑 `fsdt lint` 看全量报告；确认要强行生成请加 --skip-verify。');
      return EXIT_FAIL;
    }
  }

  const targets = resolveTargets(flagList(args, 'target'));
  const schemaHash = computeSchemaHash(ir);

  const previous = await readManifest(source);
  // 整个 ManifestFile 都要留着：合并要用它记录的区块基线哈希判断「这段有没有被改过」
  const previousFiles = new Map((previous?.files ?? []).map((f) => [f.path, f]));

  const rendered = new Map<string, RenderedFile[]>();
  for (const spec of targets) rendered.set(spec.id, await renderTarget(spec, ir, out ?? ctx.cwd));

  if (out === undefined) {
    // --check 是门禁，不是预览：它只该输出「一致/漂移」这一条结论。
    // 早先把预览清单也打出来，导致 CI 日志里 28 行文件名淹没了真正要看的那一行。
    if (check) {
      return await checkOnly(ctx, source, targets, ir, rendered, schemaHash, previous);
    }
    // 预览：只列计划，不写盘
    const planned: string[] = [];
    for (const spec of targets) {
      for (const file of rendered.get(spec.id) ?? []) planned.push(`${spec.subdir}/${file.path}`);
    }
    ctx.io.stderr(`预览模式（未写盘）：将生成 ${planned.length} 个文件。加 --out <dir> 实际生成。`);
    for (const path of planned) ctx.io.stdout(path);
    return EXIT_OK;
  }

  const root = join(ctx.cwd, out);
  const outcomes: Array<{ spec: TargetSpec; outcome: GenOutcome }> = [];
  const manifestFiles: ManifestFile[] = [];
  let anyConflict = false;

  for (const spec of targets) {
    const files = rendered.get(spec.id) ?? [];
    const outcome = emptyOutcome();
    for (const file of files) {
      const manifestPath = `${spec.subdir}/${file.path}`;
      const diskPath = join(root, manifestPath);
      outcome.planned.push(manifestPath);
      // 基线永远记纯净生成内容，与本次写出去的是不是合并结果无关
      manifestFiles.push(manifestEntry(file, manifestPath));

      const onDisk = existsSync(diskPath) ? await readFile(diskPath, 'utf8') : undefined;
      const decision =
        onDisk === undefined
          ? ({ action: 'write', content: file.content, reasons: [] } as WriteDecision)
          : resolveWrite(file, onDisk, previousFiles.get(manifestPath), force);

      switch (decision.action) {
        case 'unchanged':
          outcome.unchanged.push(manifestPath);
          break;
        case 'merged':
          await writeText(diskPath, decision.content);
          outcome.merged.push(manifestPath);
          break;
        case 'conflict':
          outcome.conflicted.push(manifestPath);
          outcome.conflictReasons[manifestPath] = decision.reasons;
          anyConflict = true;
          break;
        default:
          await writeText(diskPath, decision.content);
          outcome.written.push(manifestPath);
      }
    }
    outcomes.push({ spec, outcome });
  }

  await writeText(
    manifestPathOf(source),
    `${JSON.stringify(mergeManifest(manifestFiles, schemaHash, ir, targets, relativeOutputRoot(source.projectRoot, out)), null, 2)}\n`,
  );

  ctx.io.stderr(`✓ 已生成到 ${rel(ctx.cwd, root)}`);
  ctx.io.stdout(summarize(outcomes));
  if (anyConflict) {
    // 只说「有冲突」等于把排查工作丢回用户：得说清是哪个文件的哪个区块、为什么
    const details: string[] = [];
    for (const { outcome } of outcomes) {
      for (const path of outcome.conflicted) {
        for (const reason of outcome.conflictReasons[path] ?? []) details.push(`  ${path} → ${reason}`);
      }
    }
    if (details.length > 0) ctx.io.stderr(`\n${details.slice(0, 20).join('\n')}`);
    ctx.io.stderr('⚠ 有文件未能自动合并，已保留磁盘内容。确认要覆盖请加 --force。');
    return EXIT_FAIL;
  }
  return EXIT_OK;
}

function mergeManifest(
  files: ManifestFile[],
  schemaHash: string,
  ir: IR,
  targets: TargetSpec[],
  outputRoot: string,
): Manifest {
  const sorted = files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const generator: Record<string, string> = {};
  for (const spec of targets) generator[spec.id] = spec.generator.version;
  return {
    manifestVersion: 1,
    generationId: `gen_${bareHash(schemaHash).slice(0, 12)}`,
    schemaHash,
    files: sorted,
    createdAt: ir.meta.updatedAt,
    generator,
    warnings: [],
    ...(outputRoot.length > 0 ? { outputRoot } : {}),
  };
}

async function readManifest(source: IrSource): Promise<Manifest | undefined> {
  const path = manifestPathOf(source);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Manifest;
  } catch {
    // manifest 损坏时按「无历史」处理：宁可按全量重新生成，也不能因为读不了基线就崩溃
    return undefined;
  }
}

/**
 * `--check` 的实现。
 *
 * 三类差异都要报出来，且都算失败：
 * - `drifted`：磁盘内容与本次生成不同 → 「改了画布没重新生成」或「改了代码没回写画布」；
 * - `missing`：manifest 里有、磁盘上没有 → 文件被删了；
 * - `stale`：磁盘上有、本次不再生成 → 通常意味着节点被删，但生成器不会删文件。
 *
 * 只比较内容而不比较 IR 哈希是刻意的：IR 变了但生成物恰好没变（例如只挪了坐标，
 * 语义哈希不变）不该让 CI 红灯。**以产物为准则不会误报**。
 */
async function checkOnly(
  ctx: CommandContext,
  source: IrSource,
  targets: TargetSpec[],
  ir: IR,
  rendered: Map<string, RenderedFile[]>,
  schemaHash: string,
  previous: Manifest | undefined,
): Promise<number> {
  void ir;
  // 用 manifest 里记录的输出根，而不是「这次命令行有没有给 --out」：
  // 生成与检查是两次独立调用，参数不同是常态。
  const root = join(source.projectRoot, previous?.outputRoot ?? '');
  const expected = new Map<string, string>();
  for (const spec of targets) {
    for (const file of rendered.get(spec.id) ?? []) {
      expected.set(`${spec.subdir}/${file.path}`, file.content);
    }
  }

  const drifted: string[] = [];
  const missing: string[] = [];
  const previousFiles = new Map((previous?.files ?? []).map((f) => [f.path, f]));
  let checked = 0;
  for (const [path, content] of expected) {
    const diskPath = join(root, path);
    if (!existsSync(diskPath)) {
      missing.push(path);
      continue;
    }
    checked++;
    const existing = await readFile(diskPath, 'utf8');
    if (existing === content) continue;

    // 区块内的手写内容（填好的 todo、自定义区块）不算漂移——那是工具允许甚至鼓励的。
    // 判定标准与 gen 完全一致：用同一套合并规则算一遍，合并结果等于磁盘就说明
    // 「除了允许手写的地方，其余都对得上」。少了这一步，任何往 todo 区块里写代码的
    // 项目都会被 CI 永久卡红。
    //
    // 只认 merged / unchanged 两种结论：conflict 与 unmergeable 都说明「磁盘上有
    // 生成器管不到的内容」，那正是要拦下来的漂移。
    const prev = previousFiles.get(path);
    if (prev !== undefined && hashContent(existing) !== prev.hash) {
      const merged = mergeRegions(content, existing, prev.regions ?? []);
      const resolved = merged.status === 'merged' || merged.status === 'unchanged';
      if (resolved && merged.content === existing) continue;
    }
    drifted.push(path);
  }

  const stale = (previous?.files ?? []).map((f) => f.path).filter((p) => !expected.has(p));

  if (drifted.length === 0 && missing.length === 0) {
    ctx.io.stdout(`✓ 生成物与画布一致（检查 ${checked} 个文件，IR ${schemaHash.slice(0, 19)}…）\n`);
    if (stale.length > 0) {
      ctx.io.stderr(`提示：${stale.length} 个已提交文件不再由当前画布生成（生成器不会自动删除）：\n${stale.map((p) => `  ${p}`).join('\n')}`);
    }
    return EXIT_OK;
  }

  const sections: string[] = ['✗ 检测到契约漂移：'];
  if (drifted.length > 0) {
    sections.push(`\n内容不一致（${drifted.length}）：\n${drifted.map((p) => `  ${p}`).join('\n')}`);
  }
  if (missing.length > 0) {
    sections.push(`\n文件缺失（${missing.length}）：\n${missing.map((p) => `  ${p}`).join('\n')}`);
  }
  sections.push('\n请执行 `fsdt gen --out <dir>` 重新生成，或把代码改动回写到画布。');
  ctx.io.stderr(sections.join('\n'));
  return EXIT_FAIL;
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
}
