import { describe, expect, it } from 'vitest';

import { canonicalize, semanticView, stableStringify } from '../src/index.js';
import { buildFixture, cloneIR } from '../src/testing/fixtures.js';

describe('canonicalize 规范化', () => {
  it('键顺序不同但语义相同 → 输出相同', () => {
    const a = canonicalize({ b: 1, a: 2 });
    const b = canonicalize({ a: 2, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":2,"b":1}');
  });

  it('嵌套对象同样排序', () => {
    expect(canonicalize({ z: { y: 1, x: 2 } })).toBe('{"z":{"x":2,"y":1}}');
  });

  it('数组顺序是语义，不排序', () => {
    expect(canonicalize([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalize(['b', 'a'])).toBe('["b","a"]');
  });

  it('sortKeys: false 保留原序', () => {
    expect(canonicalize({ b: 1, a: 2 }, { sortKeys: false })).toBe('{"b":1,"a":2}');
  });

  it('省略 undefined 值的键', () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('-0 与 0 视为同一值', () => {
    expect(canonicalize(-0)).toBe(canonicalize(0));
    expect(canonicalize([-0])).toBe('[0]');
  });

  it('NaN / Infinity 归一为 null（JSON 无法表示）', () => {
    expect(canonicalize(Number.NaN)).toBe('null');
    expect(canonicalize(Number.POSITIVE_INFINITY)).toBe('null');
  });

  it('字符串安全转义', () => {
    expect(canonicalize('a"b')).toBe('"a\\"b"');
    expect(canonicalize('line\nbreak')).toBe('"line\\nbreak"');
  });

  it('null 与 undefined 在数组里都变 null', () => {
    expect(canonicalize([null, undefined])).toBe('[null,null]');
  });

  it('Date 用 ISO 表示', () => {
    const d = new Date('2026-01-02T03:04:05.000Z');
    expect(canonicalize({ t: d })).toBe('{"t":"2026-01-02T03:04:05.000Z"}');
  });

  it('对同一 IR 稳定', () => {
    const { ir } = buildFixture();
    expect(canonicalize(ir)).toBe(canonicalize(cloneIR(ir)));
  });
});

describe('stableStringify', () => {
  it('保留键序且缩进，便于人读 diff', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe('{\n  "b": 1,\n  "a": 2\n}');
  });

  it('省略 undefined', () => {
    expect(stableStringify({ a: 1, b: undefined })).toContain('"a"');
    expect(stableStringify({ a: 1, b: undefined })).not.toContain('"b"');
  });
});

describe('semanticView 语义视图', () => {
  it('拖动节点（改位置）不改变语义视图', () => {
    const { ir, deviceTable } = buildFixture();
    const moved = cloneIR(ir);
    const target = moved.nodes.find((n) => n.id === deviceTable.id);
    if (target === undefined) throw new Error('节点丢失');
    target.position = { x: 999, y: 999 };
    expect(canonicalize(semanticView(moved))).toBe(canonicalize(semanticView(ir)));
  });

  it('折叠状态与视口不改变语义视图', () => {
    const { ir } = buildFixture();
    const copy = cloneIR(ir);
    const node = copy.nodes[0];
    if (node === undefined) throw new Error('节点丢失');
    node.collapsed = !node.collapsed;
    const canvas = copy.canvases[0];
    if (canvas === undefined) throw new Error('画布丢失');
    canvas.viewport = { x: 123, y: 456, zoom: 2 };

    expect(canonicalize(semanticView(copy))).toBe(canonicalize(semanticView(ir)));
  });

  it('改字段名会改变语义视图', () => {
    const { ir, deviceNameField } = buildFixture();
    const copy = cloneIR(ir);
    for (const node of copy.nodes) {
      if (node.kind !== 'table') continue;
      const f = node.table.fields.find((x) => x.id === deviceNameField.id);
      if (f !== undefined) f.name = 'renamed';
    }
    expect(canonicalize(semanticView(copy))).not.toBe(canonicalize(semanticView(ir)));
  });

  it('改备注文字不改变语义视图（备注只是评审信息）', () => {
    const { ir } = buildFixture();
    const copy = cloneIR(ir);
    const node = copy.nodes[0];
    if (node === undefined) throw new Error('节点丢失');
    node.notes = '这段说明不影响生成';
    expect(canonicalize(semanticView(copy))).toBe(canonicalize(semanticView(ir)));
  });

  it('排除画布背景图片（纯展示）', () => {
    const { ir } = buildFixture();
    const copy = cloneIR(ir);
    const canvas = copy.canvases[0];
    if (canvas === undefined) throw new Error('画布丢失');
    canvas.background = {
      assetId: 'as_aaaaaaaaaaaa',
      opacity: 0.3,
      locked: true,
      fit: 'contain',
      offset: { x: 0, y: 0 },
      scale: 1,
    };
    expect(canonicalize(semanticView(copy))).toBe(canonicalize(semanticView(ir)));
  });
});
