import { mkdtemp, mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFixture } from '@fsdt/core-ir/testing';
import { saveIR } from '@fsdt/core-ir';
import { beforeEach, describe, expect, it } from 'vitest';
import { parseArgs, rejectUnknown, flagBool, flagList, flagString } from '../src/args.js';
import { createContext, type CommandContext } from '../src/context.js';
import { EXIT_FAIL, EXIT_OK, EXIT_USAGE, UsageError } from '../src/io.js';
import { runCli } from '../src/main.js';
import { diffIR } from '../src/commands/diff.js';
import { relativeOutputRoot } from '../src/commands/gen.js';
import { COMMANDS } from '../src/help.js';

// ────────────────────────────── 测试脚手架 ──────────────────────────────

interface Captured extends CommandContext {
  stdoutText: string;
  stderrText: string;
}

function capture(cwd: string, env: Record<string, string | undefined> = {}): Captured {
  let out = '';
  let err = '';
  const ctx = createContext({
    cwd,
    env,
    io: {
      stdout: (t) => {
        out += `${t}\n`;
      },
      stderr: (t) => {
        err += `${t}\n`;
      },
    },
  });
  return {
    ...ctx,
    get stdoutText() {
      return out;
    },
    get stderrText() {
      return err;
    },
  } as Captured;
}

let dir: string;

/** 建一个带 design/ir.json 的临时项目 */
async function projectWithIr(): Promise<{ dir: string; irPath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'fsdt-cli-'));
  await mkdir(join(root, 'design'), { recursive: true });
  const irPath = join(root, 'design', 'ir.json');
  await saveIR(irPath, buildFixture().ir);
  return { dir: root, irPath };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fsdt-cli-empty-'));
});

// ────────────────────────────── 参数解析 ──────────────────────────────

describe('参数解析', () => {
  it('--key value 与 --key=value 等价', () => {
    const a = parseArgs(['lint', '--format', 'json']);
    const b = parseArgs(['lint', '--format=json']);
    expect(flagString(a, 'format')).toBe('json');
    expect(flagString(b, 'format')).toBe('json');
  });

  it('布尔开关不带值时是 true', () => {
    const args = parseArgs(['gen', '--check']);
    expect(flagBool(args, 'check')).toBe(true);
    expect(flagString(args, 'check')).toBeUndefined();
  });

  it('重复参数收集成数组；逗号分隔等价于重复', () => {
    expect(flagList(parseArgs(['gen', '--target', 'vue', '--target', 'nestjs']), 'target')).toEqual(['vue', 'nestjs']);
    expect(flagList(parseArgs(['gen', '--target', 'vue,nestjs']), 'target')).toEqual(['vue', 'nestjs']);
  });

  it('位置参数与 -- 之后的透传', () => {
    expect(parseArgs(['import', 'figma', '--file', 'k']).positionals).toEqual(['import', 'figma']);
    expect(parseArgs(['--', '-weird']).positionals).toEqual(['-weird']);
  });

  it('拼错的参数被拒绝而不是静默忽略（否则命令会跑成默认行为）', () => {
    const args = parseArgs(['gen', '--ou', './out']);
    expect(rejectUnknown(args, ['out']).length).toBeGreaterThan(0);
  });

  it('未知短选项报错', () => {
    expect(parseArgs(['lint', '-x']).errors).toHaveLength(1);
  });
});

// ────────────────────────────── 入口与帮助 ──────────────────────────────

describe('入口', () => {
  it('无参数打印全局帮助，退出码 0', async () => {
    const ctx = capture(dir);
    expect(await runCli([], ctx)).toBe(EXIT_OK);
    expect(ctx.stdoutText).toContain('fsdt');
    expect(ctx.stdoutText).toContain('退出码');
  });

  it('--version 输出版本号', async () => {
    const ctx = capture(dir);
    expect(await runCli(['--version'], ctx)).toBe(EXIT_OK);
    expect(ctx.stdoutText.trim()).toMatch(/^0\.\d+\.\d+$/);
  });

  it('未知命令退出码 2 并给出帮助', async () => {
    const ctx = capture(dir);
    expect(await runCli(['frobnicate'], ctx)).toBe(EXIT_USAGE);
    expect(ctx.stderrText).toContain('未知命令');
  });

  it('子命令 --help 不执行命令本体（没有 IR 也能看帮助）', async () => {
    const ctx = capture(dir);
    expect(await runCli(['lint', '--help'], ctx)).toBe(EXIT_OK);
    expect(ctx.stdoutText).toContain('fsdt lint');
    expect(ctx.stderrText).toBe('');
  });

  it('每条命令的 help 里都带可直接粘贴的示例', async () => {
    const ctx = capture(dir);
    for (const doc of COMMANDS) {
      const c = capture(dir);
      await runCli([doc.name, '--help'], c);
      expect(c.stdoutText).toContain('示例：');
      expect(c.stdoutText).toContain(doc.example.split(' ')[0] ?? '');
    }
    void ctx;
  });

  it('缺 design/ir.json 时报用法错误并提示 fsdt init', async () => {
    const ctx = capture(dir);
    expect(await runCli(['lint'], ctx)).toBe(EXIT_USAGE);
    expect(ctx.stderrText).toContain('fsdt init');
  });
});

// ────────────────────────────── init ──────────────────────────────

describe('init', () => {
  it('创建 design/ir.json 与 assets/，并打印下一步', async () => {
    const ctx = capture(dir);
    expect(await runCli(['init', '--name', '测试项目'], ctx)).toBe(EXIT_OK);
    const ir = JSON.parse(await readFile(join(dir, 'design', 'ir.json'), 'utf8')) as { project: { name: string } };
    expect(ir.project.name).toBe('测试项目');
    expect((await stat(join(dir, 'design', 'assets'))).isDirectory()).toBe(true);
    expect(ctx.stdoutText).toContain('fsdt gen');
  });

  it('已存在 ir.json 时拒绝覆盖（退出码 1，不是静默成功）', async () => {
    await runCli(['init'], capture(dir));
    const ctx = capture(dir);
    expect(await runCli(['init'], ctx)).toBe(EXIT_FAIL);
    expect(ctx.stderrText).toContain('已存在');
  });

  it('--force 才覆盖', async () => {
    await runCli(['init'], capture(dir));
    const ctx = capture(dir);
    expect(await runCli(['init', '--force'], ctx)).toBe(EXIT_OK);
  });
});

// ────────────────────────────── lint ──────────────────────────────

describe('lint 命令', () => {
  it('--format json 输出可解析结构，提示信息走 stderr', async () => {
    const { dir: root } = await projectWithIr();
    const ctx = capture(root);
    const code = await runCli(['lint', '--format', 'json'], ctx);
    const parsed = JSON.parse(ctx.stdoutText) as { issues: unknown[]; stats: { error: number } };
    expect(Array.isArray(parsed.issues)).toBe(true);
    expect(typeof parsed.stats.error).toBe('number');
    expect(code === EXIT_OK || code === EXIT_FAIL).toBe(true);
  });

  it('--format sarif 输出 SARIF 2.1.0', async () => {
    const { dir: root } = await projectWithIr();
    const ctx = capture(root);
    await runCli(['lint', '--format', 'sarif'], ctx);
    const sarif = JSON.parse(ctx.stdoutText) as { version: string; runs: unknown[] };
    expect(sarif.version).toBe('2.1.0');
    expect(sarif.runs.length).toBe(1);
  });

  it('--fail-on none 永远退出 0', async () => {
    const { dir: root } = await projectWithIr();
    expect(await runCli(['lint', '--fail-on', 'none'], capture(root))).toBe(EXIT_OK);
  });

  it('--fail-on info 时任何 issue 都会失败', async () => {
    const { dir: root } = await projectWithIr();
    const ctx = capture(root);
    const code = await runCli(['lint', '--fail-on', 'info', '--format', 'json'], ctx);
    const parsed = JSON.parse(ctx.stdoutText) as { issues: unknown[] };
    expect(code).toBe(parsed.issues.length > 0 ? EXIT_FAIL : EXIT_OK);
  });

  it('非法 --format 退出码 2', async () => {
    const { dir: root } = await projectWithIr();
    expect(await runCli(['lint', '--format', 'xml'], capture(root))).toBe(EXIT_USAGE);
  });

  it('--ir 显式指定文件时忽略向上查找', async () => {
    const custom = join(dir, 'custom.json');
    await saveIR(custom, buildFixture().ir);
    const ctx = capture(dir);
    expect(await runCli(['lint', '--ir', custom, '--format', 'json'], ctx)).toBeGreaterThanOrEqual(0);
    expect(() => JSON.parse(ctx.stdoutText)).not.toThrow();
  });
});

// ────────────────────────────── compile ──────────────────────────────

describe('compile 命令', () => {
  it('默认只读：不给 --out 时输出 OpenAPI 到 stdout', async () => {
    const { dir: root } = await projectWithIr();
    const ctx = capture(root);
    expect(await runCli(['compile'], ctx)).toBe(EXIT_OK);
    expect(ctx.stdoutText).toContain('openapi:');
  });

  it('--format json 输出 JSON 契约', async () => {
    const { dir: root } = await projectWithIr();
    const ctx = capture(root);
    await runCli(['compile', '--format', 'json'], ctx);
    const doc = JSON.parse(ctx.stdoutText) as { openapi: string };
    expect(doc.openapi.startsWith('3.1')).toBe(true);
  });

  it('--stdout 输出自包含 JSON 包（AI agent 的工具面）', async () => {
    const { dir: root } = await projectWithIr();
    const ctx = capture(root);
    expect(await runCli(['compile', '--stdout'], ctx)).toBe(EXIT_OK);
    const bundle = JSON.parse(ctx.stdoutText) as {
      openapi: { document: unknown };
      uiSchema: { pages: unknown[] };
      samples: { seed: number };
      lint: { stats: unknown };
    };
    expect(bundle.openapi.document).toBeDefined();
    expect(bundle.uiSchema.pages.length).toBeGreaterThan(0);
    expect(typeof bundle.samples.seed).toBe('number');
    expect(bundle.lint.stats).toBeDefined();
  });

  it('同一 IR 两次 --stdout 输出字节一致（可进 CI）', async () => {
    const { dir: root } = await projectWithIr();
    const a = capture(root);
    const b = capture(root);
    await runCli(['compile', '--stdout'], a);
    await runCli(['compile', '--stdout'], b);
    expect(a.stdoutText).toBe(b.stdoutText);
  });

  it('--out 落盘三份产物，且不写进 cwd 之外', async () => {
    const { dir: root } = await projectWithIr();
    const ctx = capture(root);
    expect(await runCli(['compile', '--out', './out'], ctx)).toBe(EXIT_OK);
    const openapi = await readFile(join(root, 'out', 'openapi.yaml'), 'utf8');
    expect(openapi).toContain('openapi');
    const ui = JSON.parse(await readFile(join(root, 'out', 'ui-schema.json'), 'utf8')) as { pages: unknown[] };
    expect(ui.pages.length).toBeGreaterThan(0);
    const seed = JSON.parse(await readFile(join(root, 'out', 'seed.json'), 'utf8')) as Record<string, unknown[]>;
    expect(Object.keys(seed).length).toBeGreaterThan(0);
  });

  it('--no-samples 时产物里没有 seed.json', async () => {
    const { dir: root } = await projectWithIr();
    await runCli(['compile', '--out', './out', '--no-samples'], capture(root));
    await expect(stat(join(root, 'out', 'seed.json'))).rejects.toThrow();
  });

  it('--seed 非法时报用法错误', async () => {
    const { dir: root } = await projectWithIr();
    expect(await runCli(['compile', '--seed', 'abc'], capture(root))).toBe(EXIT_USAGE);
  });
});

// ────────────────────────────── gen ──────────────────────────────

describe('gen 命令', () => {
  it('不给 --out 只预览，不写任何文件', async () => {
    const { dir: root } = await projectWithIr();
    const ctx = capture(root);
    expect(await runCli(['gen', '--target', 'vue'], ctx)).toBe(EXIT_OK);
    expect(ctx.stdoutText).toContain('src/main.ts');
    await expect(stat(join(root, 'frontend'))).rejects.toThrow();
  });

  it('--out 实际生成前后端到各自子目录', async () => {
    const { dir: root } = await projectWithIr();
    const ctx = capture(root);
    expect(await runCli(['gen', '--out', './output'], ctx)).toBe(EXIT_OK);
    expect((await stat(join(root, 'output', 'frontend', 'package.json'))).isFile()).toBe(true);
    expect((await stat(join(root, 'output', 'backend', 'package.json'))).isFile()).toBe(true);
    // manifest 写在 design/ 下，作为漂移检测基线
    const manifest = JSON.parse(await readFile(join(root, 'design', 'generated.manifest.json'), 'utf8')) as {
      schemaHash: string;
      outputRoot: string;
      files: Array<{ path: string }>;
    };
    expect(manifest.schemaHash.startsWith('sha256:')).toBe(true);
    expect(manifest.outputRoot).toBe('output');
    expect(manifest.files.length).toBeGreaterThan(0);
  });

  it('--check 与 --out 互斥（否则 CI 会自己把漂移修掉）', async () => {
    const { dir: root } = await projectWithIr();
    const ctx = capture(root);
    expect(await runCli(['gen', '--check', '--out', './o'], ctx)).toBe(EXIT_USAGE);
    expect(ctx.stderrText).toContain('互斥');
  });

  it('--check 在产物一致时退出 0，在产物被改后退出 1', async () => {
    const { dir: root } = await projectWithIr();
    await runCli(['gen', '--out', './output'], capture(root));

    const clean = capture(root);
    expect(await runCli(['gen', '--check'], clean)).toBe(EXIT_OK);
    expect(clean.stdoutText).toContain('一致');

    const pagePath = join(root, 'output', 'frontend', 'src', 'views', 'devices.vue');
    await writeFile(pagePath, '<template><div>手改过</div></template>\n', 'utf8');
    const dirty = capture(root);
    expect(await runCli(['gen', '--check'], dirty)).toBe(EXIT_FAIL);
    expect(dirty.stderrText).toContain('devices.vue');
  });

  it('--check 能发现文件被删除', async () => {
    const { dir: root } = await projectWithIr();
    await runCli(['gen', '--out', './output', '--target', 'vue'], capture(root));
    const { rm } = await import('node:fs/promises');
    await rm(join(root, 'output', 'frontend', 'src', 'main.ts'));
    const ctx = capture(root);
    expect(await runCli(['gen', '--check'], ctx)).toBe(EXIT_FAIL);
    expect(ctx.stderrText).toContain('缺失');
  });

  it('手改过的 if-generated 文件默认不被覆盖，--force 才覆盖', async () => {
    const { dir: root } = await projectWithIr();
    await runCli(['gen', '--out', './output', '--target', 'vue'], capture(root));
    const mainPath = join(root, 'output', 'frontend', 'src', 'main.ts');
    await writeFile(mainPath, '// 我自己写的入口\n', 'utf8');

    const guarded = capture(root);
    expect(await runCli(['gen', '--out', './output', '--target', 'vue'], guarded)).toBe(EXIT_FAIL);
    expect(await readFile(mainPath, 'utf8')).toContain('我自己写的入口');

    const forced = capture(root);
    await runCli(['gen', '--out', './output', '--target', 'vue', '--force'], forced);
    expect(await readFile(mainPath, 'utf8')).not.toContain('我自己写的入口');
  });

  it('重复生成未改动时全部 unchanged（幂等）', async () => {
    const { dir: root } = await projectWithIr();
    await runCli(['gen', '--out', './output'], capture(root));
    const ctx = capture(root);
    expect(await runCli(['gen', '--out', './output'], ctx)).toBe(EXIT_OK);
    expect(ctx.stdoutText).toContain('新增/更新 0');
  });

  it('非法 --target 退出码 2', async () => {
    const { dir: root } = await projectWithIr();
    expect(await runCli(['gen', '--target', 'angular'], capture(root))).toBe(EXIT_USAGE);
  });

  it('relativeOutputRoot 产出 POSIX 分隔符的相对路径', () => {
    expect(relativeOutputRoot('/a/b', './output')).toBe('output');
    expect(relativeOutputRoot('/a/b', 'out/nested')).toBe('out/nested');
    expect(relativeOutputRoot('/a/b', '.')).toBe('');
  });
});

// ────────────────────────────── sample ──────────────────────────────

describe('sample 命令', () => {
  it('同 seed 两次输出完全一致', async () => {
    const { dir: root } = await projectWithIr();
    const a = capture(root);
    const b = capture(root);
    await runCli(['sample', '--seed', '7'], a);
    await runCli(['sample', '--seed', '7'], b);
    expect(a.stdoutText).toBe(b.stdoutText);
  });

  it('不同 seed 输出不同', async () => {
    const { dir: root } = await projectWithIr();
    const a = capture(root);
    const b = capture(root);
    await runCli(['sample', '--seed', '1'], a);
    await runCli(['sample', '--seed', '2'], b);
    expect(a.stdoutText).not.toBe(b.stdoutText);
  });

  it('敏感字段被掩码', async () => {
    const { dir: root } = await projectWithIr();
    const ctx = capture(root);
    await runCli(['sample'], ctx);
    expect(ctx.stdoutText).not.toContain('password123');
  });

  it('--out 每表一个文件并生成 index.ts', async () => {
    const { dir: root } = await projectWithIr();
    await runCli(['sample', '--out', './mocks', '--rows', '2'], capture(root));
    const index = await readFile(join(root, 'mocks', 'index.ts'), 'utf8');
    expect(index).toContain('export { default as');
    const rows = JSON.parse(await readFile(join(root, 'mocks', 'devices.json'), 'utf8')) as unknown[];
    expect(rows).toHaveLength(2);
  });

  it('--rows 非正整数时报用法错误', async () => {
    const { dir: root } = await projectWithIr();
    expect(await runCli(['sample', '--rows', '0'], capture(root))).toBe(EXIT_USAGE);
  });
});

// ────────────────────────────── export ──────────────────────────────

describe('export 命令', () => {
  it('不给 --out 时 svg 打到 stdout', async () => {
    const { dir: root } = await projectWithIr();
    const ctx = capture(root);
    expect(await runCli(['export', '--format', 'svg'], ctx)).toBe(EXIT_OK);
    expect(ctx.stdoutText).toContain('<svg');
  });

  it('png 没有 --out 时明确拒绝（不能往终端吐二进制）', async () => {
    const { dir: root } = await projectWithIr();
    const ctx = capture(root);
    expect(await runCli(['export', '--format', 'png'], ctx)).toBe(EXIT_USAGE);
    expect(ctx.stderrText).toContain('--out');
  });

  it('--out 落盘 svg 与 mermaid', async () => {
    const { dir: root } = await projectWithIr();
    await runCli(['export', '--format', 'svg,mermaid', '--out', './docs'], capture(root));
    const svg = await readFile(join(root, 'docs', '画布-1.svg'), 'utf8');
    expect(svg.startsWith('<svg')).toBe(true);
    const mermaid = await readFile(join(root, 'docs', '画布-1.mmd'), 'utf8');
    expect(mermaid).toContain('flowchart');
  });

  it('--format png --out 产出合法 PNG 头', async () => {
    const { dir: root } = await projectWithIr();
    await runCli(['export', '--format', 'png', '--out', './docs'], capture(root));
    const bytes = await readFile(join(root, 'docs', '画布-1.png'));
    expect(bytes[0]).toBe(0x89);
    expect(bytes.length).toBeGreaterThan(1000);
  }, 30000);

  it('非法 --format 列出可用值', async () => {
    const { dir: root } = await projectWithIr();
    const ctx = capture(root);
    expect(await runCli(['export', '--format', 'webp'], ctx)).toBe(EXIT_USAGE);
    expect(ctx.stderrText).toContain('svg');
  });

  it('--canvas 找不到时报用法错误', async () => {
    const { dir: root } = await projectWithIr();
    expect(await runCli(['export', '--canvas', '不存在的画布'], capture(root))).toBe(EXIT_USAGE);
  });
});

// ────────────────────────────── diff ──────────────────────────────

describe('diff 命令', () => {
  it('未被 --from 指向时提示用法', async () => {
    const { dir: root } = await projectWithIr();
    const ctx = capture(root);
    expect(await runCli(['diff'], ctx)).toBe(EXIT_USAGE);
    expect(ctx.stderrText).toContain('--from');
  });

  it('只改坐标不算契约变化', async () => {
    const { dir: root, irPath } = await projectWithIr();
    // 基线必须来自**同一份 IR**（同一批节点 ID），只挪坐标。
    // 用 buildFixture() 再建一份是不行的：它每次生成新的随机 ID，
    // 那样比出来的全是「全部新增 + 全部删除」。
    const moved = JSON.parse(await readFile(irPath, 'utf8')) as { nodes: Array<{ position: unknown }> };
    for (const node of moved.nodes) node.position = { x: 999, y: 999 };
    const base = join(root, 'base.json');
    await writeFile(base, JSON.stringify(moved, null, 2), 'utf8');
    const ctx = capture(root);
    expect(await runCli(['diff', '--from', base], ctx)).toBe(EXIT_OK);
    expect(ctx.stdoutText).toContain('契约无变化');
  });

  it('新增字段被识别为修改', async () => {
    const { dir: root } = await projectWithIr();
    const current = JSON.parse(await readFile(join(root, 'design', 'ir.json'), 'utf8')) as ReturnType<
      typeof buildFixture
    >['ir'];
    const base = structuredClone(current);
    const table = base.nodes.find((n) => n.kind === 'table');
    if (table !== undefined && table.kind === 'table') {
      // 删掉一个字段会让页面组件/表格列的绑定悬空（IR006）。这是**故意**的：
      // diff 要能处理「基线本身有语义问题」的历史版本——真实仓库里的旧 IR
      // 很可能就是不合规的（旧版工具校验更松）。因此直接写文件绕过 saveIR 校验。
      table.table.fields = table.table.fields.slice(0, 1);
    }
    const basePath = join(root, 'base.json');
    await writeFile(basePath, JSON.stringify(base, null, 2), 'utf8');
    const ctx = capture(root);
    await runCli(['diff', '--from', basePath], ctx);
    expect(ctx.stdoutText).toContain('修改');
    expect(ctx.stdoutText).toContain('fields');
  });

  it('diffIR 能识别新增与删除节点', () => {
    const { ir } = buildFixture();
    const after = structuredClone(ir);
    after.nodes = after.nodes.filter((n) => n.kind !== 'page');
    const diff = diffIR(ir, after);
    expect(diff.removed.length).toBeGreaterThan(0);
    expect(diff.added).toHaveLength(0);
  });

  it('--format json 输出结构化差异', async () => {
    const { dir: root } = await projectWithIr();
    const base = join(root, 'base.json');
    // 清空节点必须连边一起清：saveIR 做语义校验，残留的边会因端点不存在被拒绝
    // （这里直接写文件绕过校验，是为了构造一个「合法但更旧」的基线）
    const empty = JSON.parse(await readFile(join(root, 'design', 'ir.json'), 'utf8')) as {
      nodes: unknown[];
      edges: unknown[];
    };
    empty.nodes = [];
    empty.edges = [];
    await writeFile(base, JSON.stringify(empty, null, 2), 'utf8');
    const ctx = capture(root);
    await runCli(['diff', '--from', base, '--format', 'json'], ctx);
    const parsed = JSON.parse(ctx.stdoutText) as { added: unknown[] };
    expect(parsed.added.length).toBeGreaterThan(0);
  });

  it('基线文件非法时报用法错误而不是崩溃', async () => {
    const { dir: root } = await projectWithIr();
    const bad = join(root, 'bad.json');
    await writeFile(bad, '{"not":"an ir"}', 'utf8');
    const ctx = capture(root);
    expect(await runCli(['diff', '--from', bad], ctx)).toBe(EXIT_USAGE);
    expect(ctx.stderrText).toContain('不是合法 IR');
  });
});

// ────────────────────────────── import ──────────────────────────────

describe('import 命令', () => {
  it('未知通道给出用法说明', async () => {
    const { dir: root } = await projectWithIr();
    const ctx = capture(root);
    expect(await runCli(['import', 'sketch'], ctx)).toBe(EXIT_USAGE);
    expect(ctx.stderrText).toContain('figma');
  });

  it('缺 Figma token 时提示用环境变量而不是命令行参数', async () => {
    const { dir: root } = await projectWithIr();
    const ctx = capture(root);
    expect(await runCli(['import', 'figma', '--file', 'KEY'], ctx)).toBe(EXIT_USAGE);
    expect(ctx.stderrText).toContain('FSDT_FIGMA_TOKEN');
  });

  it('缺视觉模型密钥时报错', async () => {
    const { dir: root } = await projectWithIr();
    const img = join(root, 'shot.png');
    await writeFile(img, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const ctx = capture(root);
    expect(await runCli(['import', 'image', '--file', img], ctx)).toBe(EXIT_USAGE);
    expect(ctx.stderrText).toContain('FSDT_VISION_API_KEY');
  });

  it('apply 子命令要求显式 --apply', async () => {
    const { dir: root } = await projectWithIr();
    const ctx = capture(root);
    expect(await runCli(['import', 'apply', '--decisions', 'x.json'], ctx)).toBe(EXIT_USAGE);
    expect(ctx.stderrText).toContain('--apply');
  });

  it('UsageError 是普通 Error 子类，能被 catch 区分', () => {
    expect(new UsageError('x')).toBeInstanceOf(Error);
    expect(new UsageError('x').name).toBe('UsageError');
  });
});

describe('lint --fix', () => {
  it('把可自动修复的问题改掉并写回 IR', async () => {
    const fixture = buildFixture();
    fixture.deviceNameField.name = 'Bad_Name';
    fixture.listApi.api.query = [];

    const root = await mkdtemp(join(tmpdir(), 'fsdt-cli-fix-'));
    await mkdir(join(root, 'design'), { recursive: true });
    const irPath = join(root, 'design', 'ir.json');
    await saveIR(irPath, fixture.ir);

    const ctx = capture(root);
    const code = await runCli(['lint', '--fix'], ctx);

    expect(ctx.stderrText).toContain('已修复');
    expect(code === EXIT_OK || code === EXIT_FAIL).toBe(true);

    const saved = JSON.parse(await readFile(irPath, 'utf8')) as {
      nodes: Array<{ kind: string; table?: { fields: Array<{ name: string }> }; api?: { query: Array<{ name: string }> } }>;
    };
    const table = saved.nodes.find((n) => n.kind === 'table');
    // toCamelCase('Bad_Name') → 'badName'，不是把名字猜成 deviceName
    expect(table?.table?.fields.map((f) => f.name)).toContain('badName');

    const listApi = saved.nodes.find((n) => n.kind === 'api' && n.api?.query.some((q) => q.name === 'page'));
    expect(listApi).toBeDefined();
  });

  it('没有可修复项时不改文件，只给结论', async () => {
    const { dir: root, irPath } = await projectWithIr();
    const before = await readFile(irPath, 'utf8');

    const ctx = capture(root);
    await runCli(['lint', '--fix'], ctx);

    expect(ctx.stderrText).toContain('没有可自动修复的问题');
    expect(await readFile(irPath, 'utf8')).toBe(before);
  });
});
