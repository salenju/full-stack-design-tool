import { buildFixture } from '@fsdt/core-ir/testing';
import YAML from 'yaml';
import { describe, expect, it } from 'vitest';

import { emitOpenApi, serializeOpenApi } from '../src/index.js';

describe('序列化', () => {
  it('默认输出 YAML 且以换行结尾（git 友好）', () => {
    const { ir } = buildFixture();
    const text = serializeOpenApi(emitOpenApi(ir).document);
    expect(text.endsWith('\n')).toBe(true);
    expect(text.startsWith('openapi: 3.1.0')).toBe(true);
    expect(text).not.toContain('---');
  });

  it('YAML 可被重新解析回等价文档', () => {
    const { ir } = buildFixture();
    const doc = emitOpenApi(ir).document;
    const parsed = YAML.parse(serializeOpenApi(doc));
    expect(parsed).toEqual(JSON.parse(JSON.stringify(doc)));
  });

  it('JSON 模式输出带缩进且以换行结尾', () => {
    const { ir } = buildFixture();
    const text = serializeOpenApi(emitOpenApi(ir).document, { format: 'json' });
    expect(text.endsWith('\n')).toBe(true);
    expect(() => JSON.parse(text)).not.toThrow();
    expect(text).toContain('\n  "openapi": "3.1.0"');
  });

  it('不折行：长描述保持单行（diff 里只变一行）', () => {
    const { ir, createApi } = buildFixture();
    createApi.api.description =
      '这是一段很长的接口说明，用来验证 YAML 序列化不会按行宽把它折成多行，否则每次改动都会在 diff 里制造大量噪音。';
    const text = serializeOpenApi(emitOpenApi(ir).document);
    const line = text.split('\n').find((l) => l.includes('这是一段很长的接口说明'));
    expect(line).toBeDefined();
    expect(line).toContain('不会按行宽');
  });

  it('不产生 YAML 锚点 / 别名（重复对象必须展开）', () => {
    const { ir } = buildFixture();
    const text = serializeOpenApi(emitOpenApi(ir).document);
    // $ref 是字符串，不会被当作重复对象；一旦出现 &ref_ 或 *ref_ 说明序列化配置错了
    expect(text).not.toMatch(/[&*]ref_\d+/);
  });

  it('同一文档两次序列化字节级一致', () => {
    const { ir } = buildFixture();
    const a = serializeOpenApi(emitOpenApi(ir).document);
    const b = serializeOpenApi(emitOpenApi(ir).document);
    expect(a).toBe(b);
  });

  it('序列化不修改入参文档', () => {
    const { ir } = buildFixture();
    const doc = emitOpenApi(ir).document;
    const before = JSON.stringify(doc);
    serializeOpenApi(doc);
    expect(JSON.stringify(doc)).toBe(before);
  });
});
