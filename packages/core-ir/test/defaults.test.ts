import { describe, expect, it } from 'vitest';

import {
  createEmptyIR,
  createField,
  createTableNode,
  createApiNode,
  createPageNode,
  defaultConstraintsFor,
  defaultSettings,
  isComponentType,
  IR_SCHEMA_VERSION,
  GENERATOR_ID,
  irSchema,
  newComponentId,
  type PageComponent,
} from '../src/index.js';
import { buildFixture, cloneIR } from '../src/testing/fixtures.js';

describe('defaultConstraintsFor', () => {
  it('string / text 不带任何默认约束（约束只能来自用户输入）', () => {
    // 回归保护：曾经默认给 { minLength:0, maxLength:255 }，导致生成的 OpenAPI、
    // 后端 DTO 与前端表单里凭空多出一条没人要求的长度限制。
    expect(defaultConstraintsFor('string')).toBeUndefined();
    expect(defaultConstraintsFor('text')).toBeUndefined();
  });

  it('array 带元素类型', () => {
    expect(defaultConstraintsFor('array')).toEqual({ arrayItem: 'string' });
  });

  it('enum 带空取值列表（需用户填写，但不是 undefined）', () => {
    expect(defaultConstraintsFor('enum')).toEqual({ enumValues: [] });
  });

  it('数值/布尔/日期无额外约束', () => {
    expect(defaultConstraintsFor('integer')).toBeUndefined();
    expect(defaultConstraintsFor('number')).toBeUndefined();
    expect(defaultConstraintsFor('boolean')).toBeUndefined();
    expect(defaultConstraintsFor('date')).toBeUndefined();
  });
});

describe('createField', () => {
  it('缺省为必填、非空、string 类型', () => {
    const f = createField({ name: 'title' });
    expect(f.type).toBe('string');
    expect(f.required).toBe(true);
    expect(f.nullable).toBe(false);
    expect(f.id).toMatch(/^fd_[A-Za-z0-9_-]{12}$/);
  });

  it('已给 id 时沿用（fixture 与导入场景）', () => {
    expect(createField({ name: 'x', id: 'fd_AAAAAAAAAAAA' }).id).toBe('fd_AAAAAAAAAAAA');
  });

  it('只写入显式传入的可选字段（避免 undefined 键进 JSON）', () => {
    const f = createField({ name: 'x' });
    expect(Object.keys(f)).not.toContain('comment');
    expect(Object.keys(f)).not.toContain('example');
  });

  it('example 为 undefined 时不写入，为 null 时写入（区分「未给」与「显式 null」）', () => {
    expect(createField({ name: 'a' })).not.toHaveProperty('example');
    expect(createField({ name: 'b', example: null })).toHaveProperty('example', null);
  });
});

describe('节点构造器', () => {
  it('createEmptyIR 直接通过 schema 校验（默认值即合法值）', () => {
    const ir = createEmptyIR();
    expect(() => irSchema.parse(ir)).not.toThrow();
    expect(ir.schemaVersion).toBe(IR_SCHEMA_VERSION);
    expect(ir.meta.generator).toBe(GENERATOR_ID);
    expect(ir.canvases).toHaveLength(1);
  });

  it('每个节点构造器都生成合法且唯一的 ID', () => {
    const t = createTableNode({ name: 'A' });
    const a = createApiNode({ name: 'B' });
    const p = createPageNode({ name: 'C' });
    expect(new Set([t.id, a.id, p.id]).size).toBe(3);
    for (const id of [t.id, a.id, p.id]) expect(id).toMatch(/^nd_[A-Za-z0-9_-]{12}$/);
  });

  it('构造出的节点各自通过 schema 校验', () => {
    const ir = createEmptyIR();
    const canvasId = ir.canvases[0]?.id ?? '';
    const table = createTableNode({ name: '设备', canvasId });
    ir.nodes.push(table);
    expect(() => irSchema.parse(ir)).not.toThrow();
  });

  it('createPageNode 的 title 默认取 name', () => {
    expect(createPageNode({ name: '用户详情' }).page.title).toBe('用户详情');
  });

  it('组件构造器生成唯一 componentId', () => {
    const ids = new Set(Array.from({ length: 100 }, () => newComponentId()));
    expect(ids.size).toBe(100);
  });
});

describe('defaultSettings', () => {
  it('返回已确认的默认值', () => {
    const s = defaultSettings();
    expect(s.frontend.framework).toBe('vue');
    expect(s.frontend.ui).toBe('element-plus');
    expect(s.frontend.apiStyle).toBe('script-setup');
    expect(s.backend.framework).toBe('nestjs');
    expect(s.backend.orm).toBe('prisma');
    expect(s.backend.auth).toBe('none');
    expect(s.generation.sampleSeed).toBe(42);
    expect(s.generation.sampleCount).toBe(20);
    expect(s.export.image).toBe('svg');
  });

  it('每次返回新对象（改一处不污染其他 IR）', () => {
    const a = defaultSettings();
    const b = defaultSettings();
    a.lint.enabled = false;
    expect(b.lint.enabled).toBe(true);
    expect(a).not.toBe(b);
  });

  it('通过 schema 校验', () => {
    const ir = createEmptyIR();
    expect(() => irSchema.parse(ir)).not.toThrow();
  });
});

describe('COMPONENT_TYPES 守卫', () => {
  it('已知类型返回 true', () => {
    expect(isComponentType('table')).toBe(true);
    expect(isComponentType('searchForm')).toBe(true);
  });

  it('未知类型返回 false', () => {
    expect(isComponentType('chart')).toBe(false);
    expect(isComponentType('')).toBe(false);
  });
});

describe('组件字段引用（不复制字段）', () => {
  it('表格列的 fieldRef 指向表中字段 ID，而非字段名副本', () => {
    const { ir, deviceNameField, listPage } = buildFixture();
    const page = ir.nodes.find((n) => n.id === listPage.id);
    if (page?.kind !== 'page') throw new Error('页面丢失');
    const table = page.page.components.find((c: PageComponent) => c.type === 'table');
    expect(table).toBeDefined();
    const cols = table !== undefined && table.type === 'table' ? table.columns : [];
    expect(cols.some((c) => c.fieldRef === deviceNameField.id)).toBe(true);
  });

  it('重命名字段后组件仍然指向同一字段（证明没有复制名字）', () => {
    const { ir, deviceNameField, listPage } = buildFixture();
    const copy = cloneIR(ir);
    for (const node of copy.nodes) {
      if (node.kind !== 'table') continue;
      const f = node.table.fields.find((x) => x.id === deviceNameField.id);
      if (f !== undefined) f.name = 'renamed';
    }
    const page = copy.nodes.find((n) => n.id === listPage.id);
    if (page?.kind !== 'page') throw new Error('页面丢失');
    const table = page.page.components.find((c: PageComponent) => c.type === 'table');
    const cols = table !== undefined && table.type === 'table' ? table.columns : [];
    expect(cols.some((c) => c.fieldRef === deviceNameField.id)).toBe(true);
  });
});


// 保持 fixture 文件被 lint 覆盖到
it('fixture 可重复构造且 ID 各不相同', () => {
  const a = buildFixture();
  const b = buildFixture();
  expect(a.deviceTable.id).not.toBe(b.deviceTable.id);
  expect(a.deviceNameField.id).not.toBe(b.deviceNameField.id);
});
