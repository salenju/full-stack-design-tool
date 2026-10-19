import { describe, expect, it } from 'vitest';

import {
  ID_PREFIX,
  isIdKind,
  isValidId,
  newAssetId,
  newCanvasId,
  newComponentId,
  newEdgeId,
  newEnumId,
  newFieldId,
  newId,
  newNodeId,
} from '../src/index.js';

const KINDS = Object.keys(ID_PREFIX) as Array<keyof typeof ID_PREFIX>;

describe('ID 生成', () => {
  it('每种类型都带正确前缀且长度固定', () => {
    for (const kind of KINDS) {
      const id = newId(kind);
      expect(id.startsWith(ID_PREFIX[kind])).toBe(true);
      expect(id).toHaveLength(ID_PREFIX[kind].length + 12);
    }
  });

  it('批量生成不重复', () => {
    const ids = new Set(Array.from({ length: 5000 }, () => newNodeId()));
    expect(ids.size).toBe(5000);
  });

  it('便捷函数与 newId 一致', () => {
    expect(isIdKind(newNodeId(), 'node')).toBe(true);
    expect(isIdKind(newFieldId(), 'field')).toBe(true);
    expect(isIdKind(newEdgeId(), 'edge')).toBe(true);
    expect(isIdKind(newComponentId(), 'component')).toBe(true);
    expect(isIdKind(newCanvasId(), 'canvas')).toBe(true);
    expect(isIdKind(newAssetId(), 'asset')).toBe(true);
    expect(isIdKind(newEnumId(), 'enum')).toBe(true);
  });

  it('ID 只包含 url-safe 字符', () => {
    for (let i = 0; i < 200; i += 1) {
      const body = newNodeId().slice(ID_PREFIX.node.length);
      expect(body).toMatch(/^[A-Za-z0-9_-]{12}$/);
    }
  });
});

describe('ID 校验', () => {
  it('接受合法 ID', () => {
    expect(isValidId(newNodeId(), 'node')).toBe(true);
    expect(isValidId(newFieldId(), 'field')).toBe(true);
  });

  it('拒绝前缀不符', () => {
    const fieldId = newFieldId();
    expect(isValidId(fieldId, 'node')).toBe(false);
  });

  it('拒绝长度不符', () => {
    expect(isValidId('nd_short', 'node')).toBe(false);
    expect(isValidId('nd_' + 'a'.repeat(13), 'node')).toBe(false);
  });

  it('拒绝裸名字（手工编辑 IR 的常见错误）', () => {
    expect(isValidId('deviceId', 'field')).toBe(false);
    expect(isValidId('', 'node')).toBe(false);
  });

  it('isIdKind 只看前缀，不看长度', () => {
    expect(isIdKind('nd_abc', 'node')).toBe(true);
    expect(isValidId('nd_abc', 'node')).toBe(false);
  });
});
