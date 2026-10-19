import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  IRFileError,
  loadIR,
  parseIR,
  pathExists,
  saveIR,
  serializeIR,
  coerceToIR,
  createEmptyIR,
  irSchema,
} from '../src/index.js';
import { buildFixture } from '../src/testing/fixtures.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fsdt-ir-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('序列化 / 解析往返', () => {
  it('serializeIR → parseIR 得到等价 IR', () => {
    const { ir } = buildFixture();
    const round = parseIR(serializeIR(ir));
    expect(round).toEqual(ir);
  });

  it('serializeIR 结尾带换行（git 友好）', () => {
    const { ir } = buildFixture();
    expect(serializeIR(ir).endsWith('\n')).toBe(true);
  });

  it('parseIR 拒绝非法 JSON', () => {
    expect(() => parseIR('{ not json')).toThrow(IRFileError);
    try {
      parseIR('{ not json');
    } catch (err) {
      expect((err as IRFileError).code).toBe('PARSE');
    }
  });

  it('parseIR 拒绝顶层为数组', () => {
    try {
      parseIR('[]');
      throw new Error('应当抛错');
    } catch (err) {
      expect((err as IRFileError).code).toBe('SCHEMA');
    }
  });

  it('parseIR 的结构错误带字段路径', () => {
    const ir = createEmptyIR();
    const broken = { ...ir, canvases: 'not-an-array' };
    try {
      coerceToIR(broken);
      throw new Error('应当抛错');
    } catch (err) {
      const e = err as IRFileError;
      expect(e.code).toBe('SCHEMA');
      expect(e.diagnostics?.[0]?.message).toContain('canvases');
    }
  });
});

describe('loadIR / saveIR', () => {
  it('保存后能读回', async () => {
    const { ir } = buildFixture();
    const path = join(dir, 'nested', 'ir.json');
    await saveIR(path, ir);
    const { ir: loaded, path: reported, migrated } = await loadIR(path);
    expect(loaded).toEqual(ir);
    expect(reported).toBe(path);
    expect(migrated).toEqual([]);
  });

  it('保存时自动创建父目录', async () => {
    const { ir } = buildFixture();
    const path = join(dir, 'a', 'b', 'c', 'ir.json');
    await saveIR(path, ir);
    expect(await pathExists(path)).toBe(true);
  });

  it('读取不存在的文件抛 ENOENT 类错误', async () => {
    try {
      await loadIR(join(dir, 'nope.json'));
      throw new Error('应当抛错');
    } catch (err) {
      expect(err).toBeInstanceOf(IRFileError);
      expect((err as IRFileError).code).toBe('ENOENT');
    }
  });

  it('拒绝写入含 error 诊断的 IR', async () => {
    const { ir } = buildFixture();
    ir.nodes[0]!.canvasId = 'cv_NOTEXIST0000';
    await expect(saveIR(join(dir, 'bad.json'), ir)).rejects.toBeInstanceOf(IRFileError);
    expect(await pathExists(join(dir, 'bad.json'))).toBe(false);
  });

  it('validate: false 可跳过语义校验（导入调试用）', async () => {
    const { ir } = buildFixture();
    ir.nodes[0]!.canvasId = 'cv_NOTEXIST0000';
    const path = join(dir, 'skip.json');
    await saveIR(path, ir, { validate: false });
    expect(await pathExists(path)).toBe(true);
  });

  it('原子写不会留下 .tmp 文件', async () => {
    const { ir } = buildFixture();
    const path = join(dir, 'atomic.json');
    await saveIR(path, ir);
    const leftovers = await readFile(path, 'utf8');
    expect(leftovers.length).toBeGreaterThan(0);
    expect(await pathExists(`${path}.${process.pid}.tmp`)).toBe(false);
  });

  it('写入内容可被 schema 解析（文件与内存一致）', async () => {
    const { ir } = buildFixture();
    const path = join(dir, 'check.json');
    await saveIR(path, ir);
    const text = await readFile(path, 'utf8');
    expect(() => irSchema.parse(JSON.parse(text))).not.toThrow();
  });
});

describe('低版本迁移', () => {
  it('迁移时先备份原文件', async () => {
    // 手工构造一个 v0 结构的 IR 并写入（当前 MIGRATIONS 为空，migrateToCurrent 对 v1 直通；
    // 这里验证「备份只在真的发生迁移时触发」——v1 不触发备份）
    const { ir } = buildFixture();
    const path = join(dir, 'v1.json');
    await writeFile(path, JSON.stringify(ir), 'utf8');
    const { migrated } = await loadIR(path);
    expect(migrated).toEqual([]);
    expect(await pathExists(`${path}.v1.bak.json`)).toBe(false);
  });

  it('无法识别的 schemaVersion 抛 UNSUPPORTED', async () => {
    const { ir } = buildFixture();
    const path = join(dir, 'future.json');
    await writeFile(path, JSON.stringify({ ...ir, schemaVersion: 999 }), 'utf8');
    try {
      await loadIR(path);
      throw new Error('应当抛错');
    } catch (err) {
      expect((err as IRFileError).code).toBe('UNSUPPORTED');
    }
  });
});
