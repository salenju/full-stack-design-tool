import { describe, expect, it } from 'vitest';

import {
  bareHash,
  computeSchemaHash,
  hashContent,
  hashRegion,
  canonicalize,
  semanticView,
} from '../src/index.js';
import { buildFixture, cloneIR } from '../src/testing/fixtures.js';

describe('computeSchemaHash', () => {
  it('同一 IR 重复计算得到相同哈希', () => {
    const { ir } = buildFixture();
    expect(computeSchemaHash(ir)).toBe(computeSchemaHash(cloneIR(ir)));
  });

  it('输出 sha256: 前缀 + 64 位十六进制', () => {
    const { ir } = buildFixture();
    expect(computeSchemaHash(ir)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('拖动节点不改变哈希（不触发无意义重新生成）', () => {
    const { ir } = buildFixture();
    const moved = cloneIR(ir);
    for (const n of moved.nodes) n.position = { x: n.position.x + 100, y: n.position.y + 50 };
    expect(computeSchemaHash(moved)).toBe(computeSchemaHash(ir));
  });

  it('改接口路径会改变哈希（契约变了）', () => {
    const { ir, listApi } = buildFixture();
    const copy = cloneIR(ir);
    const api = copy.nodes.find((n) => n.id === listApi.id);
    if (api?.kind !== 'api') throw new Error('接口丢失');
    api.api.path = '/v2/devices';
    expect(computeSchemaHash(copy)).not.toBe(computeSchemaHash(ir));
  });

  it('新增字段会改变哈希', () => {
    const { ir, deviceTable } = buildFixture();
    const copy = cloneIR(ir);
    const table = copy.nodes.find((n) => n.id === deviceTable.id);
    if (table?.kind !== 'table') throw new Error('表丢失');
    table.table.fields.push({
      id: 'fd_AAAAAAAAAAAA',
      name: 'remark',
      type: 'string',
      required: false,
      nullable: true,
    });
    expect(computeSchemaHash(copy)).not.toBe(computeSchemaHash(ir));
  });

  it('改设置（如 UI 库）会改变哈希', () => {
    const { ir } = buildFixture();
    const copy = cloneIR(ir);
    copy.settings.frontend.ui = 'naive-ui';
    expect(computeSchemaHash(copy)).not.toBe(computeSchemaHash(ir));
  });

  it('canvasId 参数只哈希指定画布', () => {
    const { ir, canvas } = buildFixture();
    const withExtraCanvas = cloneIR(ir);
    withExtraCanvas.canvases.push({
      id: 'cv_BBBBBBBBBBBB',
      name: '第二块画布',
      order: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      grid: { enabled: true, size: 8 },
    });
    // 全量哈希会变（多了一块画布）
    expect(computeSchemaHash(withExtraCanvas)).not.toBe(computeSchemaHash(ir));
    // 限定画布后不变
    expect(computeSchemaHash(withExtraCanvas, { canvasId: canvas.id })).toBe(
      computeSchemaHash(ir, { canvasId: canvas.id }),
    );
  });

  it('note 节点的文字不进哈希', () => {
    const { ir } = buildFixture();
    const copy = cloneIR(ir);
    copy.nodes.push({
      id: 'nd_CCCCCCCCCCCC',
      kind: 'note',
      name: '待办',
      codeName: 'note',
      canvasId: ir.canvases[0]?.id ?? '',
      position: { x: 0, y: 0 },
      size: { w: 200, h: 120 },
      collapsed: false,
      tags: [],
      note: { text: '这里是备注' },
    });
    // 新增 note 节点会改变节点列表（ID 变了），所以哈希会变；
    // 但改 note 的文字本身不应改变哈希
    const first = computeSchemaHash(copy);
    copy.nodes[copy.nodes.length - 1] = {
      ...(copy.nodes[copy.nodes.length - 1] as (typeof copy.nodes)[number]),
      note: { text: '换了文字' },
    } as (typeof copy.nodes)[number];
    expect(computeSchemaHash(copy)).toBe(first);
  });
});

describe('bareHash / hashContent / hashRegion', () => {
  it('bareHash 去掉前缀', () => {
    expect(bareHash('sha256:abc123')).toBe('abc123');
    expect(bareHash('abc123')).toBe('abc123');
  });

  it('hashContent 对相同内容稳定、对不同内容不同', () => {
    expect(hashContent('hello')).toBe(hashContent('hello'));
    expect(hashContent('hello')).not.toBe(hashContent('hello '));
    expect(hashContent('hello')).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('hashRegion 取短哈希且稳定', () => {
    expect(hashRegion('export const a = 1;')).toHaveLength(16);
    expect(hashRegion('export const a = 1;')).toBe(hashRegion('export const a = 1;'));
    expect(hashRegion('a')).not.toBe(hashRegion('b'));
  });
});

describe('semanticView 可检查性', () => {
  it('返回可 JSON 序列化的对象（便于 diff 排查哈希差异）', () => {
    const { ir } = buildFixture();
    const view = semanticView(ir);
    expect(() => canonicalize(view)).not.toThrow();
    expect(view).toHaveProperty('nodes');
    expect(view).toHaveProperty('edges');
    expect(view).toHaveProperty('settings');
  });
});
