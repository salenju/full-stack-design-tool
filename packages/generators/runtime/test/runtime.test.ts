import { describe, expect, it } from 'vitest';

import { createEmptyIR } from '@fsdt/core-ir';
import { buildFixture } from '@fsdt/core-ir/testing';

import { computeSchemaHash } from '@fsdt/core-ir';
import { fileHeader, parseRegions, regionMarkers, wrapRegion } from '../src/markers.js';
import { diffManifest, needsFullRegeneration, type Manifest } from '../src/manifest.js';
import { arrayLiteral, commentSafe, objectLiteral, quote, toConstantCase, Writer } from '../src/writer.js';

describe('Writer', () => {
  it('行自动带缩进', () => {
    const w = new Writer();
    w.line('a').indent().line('b').dedent().line('c');
    expect(w.toString()).toBe('a\n  b\nc\n');
  });

  it('block 内自动加减缩进', () => {
    const w = new Writer();
    w.line('fn() {').block((b) => b.line('x').block((c) => c.line('deep'))).line('}');
    expect(w.toString()).toBe('fn() {\n  x\n    deep\n}\n');
  });

  it('dedent 不会降到负层级', () => {
    const w = new Writer();
    w.dedent().dedent().line('x');
    expect(w.toString()).toBe('x\n');
  });

  it('连续 blank 只保留一个', () => {
    const w = new Writer();
    w.line('a').blank().blank().blank().line('b');
    expect(w.toString()).toBe('a\n\nb\n');
  });

  it('开头 / 结尾不留空行', () => {
    const w = new Writer();
    w.blank().line('a').blank();
    expect(w.toString()).toBe('a\n');
  });

  it('lines_ 原样展开多行文本', () => {
    const w = new Writer();
    w.lines_('a\nb\nc');
    expect(w.toString()).toBe('a\nb\nc\n');
  });

  it('自定义缩进单位', () => {
    const w = new Writer({ indentUnit: '\t' });
    w.indent().line('x');
    expect(w.toString()).toBe('\tx\n');
  });

  it('lineCount 反映已写行数', () => {
    const w = new Writer();
    w.line('a').blank().line('b');
    expect(w.lineCount).toBe(3);
  });
});

describe('字面量工具', () => {
  it('toConstantCase', () => {
    expect(toConstantCase('deviceName')).toBe('DEVICE_NAME');
    expect(toConstantCase('device-name')).toBe('DEVICE_NAME');
    expect(toConstantCase('already_snake')).toBe('ALREADY_SNAKE');
    expect(toConstantCase('id')).toBe('ID');
  });

  it('quote 转义单引号与反斜杠', () => {
    expect(quote('a')).toBe("'a'");
    expect(quote("it's")).toBe("'it\\'s'");
    expect(quote('a\\b')).toBe("'a\\\\b'");
    expect(quote('a\nb')).toBe("'a\\nb'");
    expect(quote('a\rb')).toBe("'a\\rb'");
  });

  it('quote 转义行分隔符（在 JS 源码里是非法字符）', () => {
    expect(quote('a\u2028b')).toBe("'a\\u2028b'");
    expect(quote('a\u2029b')).toBe("'a\\u2029b'");
  });

  it('commentSafe 去掉换行，避免注释吃掉下一行', () => {
    expect(commentSafe('a\nb\rc')).toBe('a b c');
  });

  it('objectLiteral 少量键写成单行', () => {
    expect(objectLiteral([['a', '1']])).toBe('{ a: 1 }');
    expect(objectLiteral([['a', '1'], ['b', '2']])).toBe('{ a: 1, b: 2 }');
  });

  it('objectLiteral 多键展开成多行', () => {
    const out = objectLiteral([['a', '1'], ['b', '2'], ['c', '3']]);
    expect(out).toBe('{\n  a: 1,\n  b: 2,\n  c: 3,\n}');
  });

  it('objectLiteral 空对象写 {}', () => {
    expect(objectLiteral([])).toBe('{}');
  });

  it('arrayLiteral 空数组写 []', () => {
    expect(arrayLiteral([])).toBe('[]');
  });

  it('arrayLiteral 少量元素单行、多量多行', () => {
    expect(arrayLiteral(['1', '2'])).toBe('[1, 2]');
    expect(arrayLiteral(['1', '2', '3', '4'])).toBe('[\n  1,\n  2,\n  3,\n  4,\n]');
  });
});

describe('区块标记', () => {
  it('TS 用 // 注释', () => {
    const m = regionMarkers('ts', { name: 'x' });
    expect(m.start).toBe('// @dsg:generated start name=x');
    expect(m.end).toBe('// @dsg:generated end name=x');
  });

  it('Vue 用 HTML 注释', () => {
    const m = regionMarkers('vue', { name: 'x', mode: 'handwritten' });
    expect(m.start).toBe('<!-- @dsg:handwritten start name=x -->');
    expect(m.end).toBe('<!-- @dsg:handwritten end name=x -->');
  });

  it('CSS / env 各自用对注释符', () => {
    expect(regionMarkers('css', { name: 'x' }).start).toBe('/* @dsg:generated start name=x */');
    expect(regionMarkers('env', { name: 'x' }).start).toBe('# @dsg:generated start name=x');
  });

  it('wrapRegion 生成三行结构', () => {
    const out = wrapRegion('ts', 'cols', 'const a = 1;');
    const lines = out.split('\n');
    expect(lines[0]).toMatch(/^\/\/ @dsg:generated start name=cols hash=[0-9a-f]{16}$/);
    expect(lines[1]).toBe('const a = 1;');
    expect(lines[2]).toBe('// @dsg:generated end name=cols');
  });

  it('内容不变时哈希不变，内容变则哈希变', () => {
    const a = wrapRegion('ts', 'x', 'aaa').split('\n')[0];
    const b = wrapRegion('ts', 'x', 'aaa').split('\n')[0];
    const c = wrapRegion('ts', 'x', 'bbb').split('\n')[0];
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('fileHeader', () => {
  const base = {
    path: 'src/a.ts',
    nodeIds: ['nd_1'],
    irHash: 'sha256:abc',
    generator: 'vue',
    generatorVersion: '1.0.0',
  };

  it('包含 file / node / ir / generator 四段', () => {
    const h = fileHeader({ ...base, language: 'ts' });
    expect(h).toContain('file=src/a.ts');
    expect(h).toContain('node=nd_1');
    expect(h).toContain('ir=sha256:abc');
    expect(h).toContain('generator=vue@1.0.0');
  });

  it('无来源节点时写 -', () => {
    expect(fileHeader({ ...base, language: 'ts', nodeIds: [] })).toContain('node=-');
  });

  it('Vue 文件头是 HTML 注释', () => {
    expect(fileHeader({ ...base, language: 'vue' }).startsWith('<!--')).toBe(true);
  });

  it('ts 文件头是 // 注释', () => {
    expect(fileHeader({ ...base, language: 'ts' }).startsWith('//')).toBe(true);
  });
});

describe('parseRegions', () => {
  it('解析出区块范围与内容', () => {
    const text = ['a', '// @dsg:generated start name=r1 hash=abc', 'x', 'y', '// @dsg:generated end name=r1', 'b'].join('\n');
    const regions = parseRegions(text);
    expect(regions.length).toBe(1);
    expect(regions[0]!.name).toBe('r1');
    expect(regions[0]!.content).toBe('x\ny');
    expect(regions[0]!.startLine).toBe(1);
    expect(regions[0]!.endLine).toBe(4);
    expect(regions[0]!.hash).toBe('abc');
  });

  it('识别 handwritten 与 todo 模式', () => {
    const text = [
      '// @dsg:handwritten start name=h',
      'x',
      '// @dsg:handwritten end name=h',
      '// @dsg:todo start name=t',
      'y',
      '// @dsg:todo end name=t',
    ].join('\n');
    const regions = parseRegions(text);
    expect(regions.map((r) => r.mode)).toEqual(['handwritten', 'todo']);
  });

  it('嵌套同名区块时只取最外层（用栈）', () => {
    const text = [
      '// @dsg:generated start name=outer',
      'a',
      '// @dsg:generated end name=outer',
      '// @dsg:generated start name=other',
      'b',
      '// @dsg:generated end name=other',
    ].join('\n');
    expect(parseRegions(text).length).toBe(2);
  });

  it('没有区块时返回空数组', () => {
    expect(parseRegions('const a = 1;')).toEqual([]);
  });

  it('只有 start 没有 end 时不产出区块', () => {
    expect(parseRegions('// @dsg:generated start name=x\na')).toEqual([]);
  });

  it('end 没有对应 start 时忽略', () => {
    expect(parseRegions('// @dsg:generated end name=x')).toEqual([]);
  });
});

describe('diffManifest', () => {
  const file = (path: string, hash: string): Manifest['files'][number] => ({
    path,
    hash,
    kind: 'page',
    sourceNodeIds: [],
    overwrite: 'if-generated',
    regions: [],
  });

  const manifest = (files: Manifest['files']): Manifest => ({
    manifestVersion: 1,
    generationId: 'g1',
    schemaHash: 'sha256:x',
    files,
    createdAt: '2026-01-01T00:00:00Z',
    generator: {},
    warnings: [],
  });

  it('无旧 manifest 时全部算新增', () => {
    const diff = diffManifest(undefined, manifest([file('a', 'h1'), file('b', 'h2')]));
    expect(diff.added).toEqual(['a', 'b']);
    expect(diff.changed).toEqual([]);
  });

  it('哈希不变不算变化', () => {
    const diff = diffManifest(manifest([file('a', 'h1')]), manifest([file('a', 'h1')]));
    expect(diff).toEqual({ added: [], changed: [], removed: [], conflicted: [] });
  });

  it('内容变化且磁盘未被手改 → changed', () => {
    const diff = diffManifest(manifest([file('a', 'h1')]), manifest([file('a', 'h2')]), new Map([['a', 'h1']]));
    expect(diff.changed).toEqual(['a']);
  });

  it('内容变化且磁盘被手改 → conflicted（只提示不覆盖）', () => {
    const diff = diffManifest(manifest([file('a', 'h1')]), manifest([file('a', 'h2')]), new Map([['a', 'manual']]));
    expect(diff.conflicted).toEqual(['a']);
    expect(diff.changed).toEqual([]);
  });

  it('磁盘文件缺失（无 actual 记录）按 changed 处理', () => {
    const diff = diffManifest(manifest([file('a', 'h1')]), manifest([file('a', 'h2')]));
    expect(diff.changed).toEqual(['a']);
  });

  it('新 manifest 里没有的路径算 removed', () => {
    const diff = diffManifest(manifest([file('a', 'h1'), file('b', 'h1')]), manifest([file('a', 'h1')]));
    expect(diff.removed).toEqual(['b']);
  });

  it('diff 结果排序稳定', () => {
    const diff = diffManifest(
      manifest([]),
      manifest([file('z', 'h'), file('a', 'h'), file('m', 'h')]),
    );
    expect(diff.added).toEqual(['a', 'm', 'z']);
  });

  it('needsFullRegeneration：无历史或格式版本不符', () => {
    expect(needsFullRegeneration(undefined)).toBe(true);
    expect(needsFullRegeneration(manifest([]))).toBe(false);
    expect(needsFullRegeneration({ ...manifest([]), manifestVersion: 2 as unknown as 1 })).toBe(true);
  });
});

describe('IR 语义哈希', () => {
  it('同一 IR 稳定，改动语义后变化', () => {
    const { ir } = buildFixture();
    const before = computeSchemaHash(ir);
    expect(computeSchemaHash(ir)).toBe(before);
    ir.nodes[0]!.name = '改名后';
    expect(computeSchemaHash(ir)).not.toBe(before);
  });

  it('只改节点坐标不改变语义哈希（否则每次拖拽都会触发全量重生成）', () => {
    const { ir } = buildFixture();
    const before = computeSchemaHash(ir);
    ir.nodes[0]!.position = { x: 999, y: 999 };
    expect(computeSchemaHash(ir)).toBe(before);
  });

  it('空 IR 也能算', () => {
    expect(computeSchemaHash(createEmptyIR({ projectName: 'x' }))).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
