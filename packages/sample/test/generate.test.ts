import { createApiNode, createEmptyIR, createField, createTableNode, newEdgeId } from '@fsdt/core-ir';
import type { Field } from '@fsdt/core-ir';
import { buildFixture } from '@fsdt/core-ir/testing';
import { describe, expect, it } from 'vitest';

import { createRng, hashSeed } from '../src/rng.js';
import { generateSamples, sensitiveFieldWarnings, toSeedJson } from '../src/generate.js';
import { detectSemantic } from '../src/semantic.js';

// ────────────────────────────── PRNG ──────────────────────────────

describe('确定性 PRNG', () => {
  it('同一 seed 产生同一序列', () => {
    const a = createRng(42);
    const b = createRng(42);
    expect([a.next(), a.next(), a.next()]).toEqual([b.next(), b.next(), b.next()]);
  });

  it('不同 seed 产生不同序列', () => {
    expect(createRng(1).next()).not.toBe(createRng(2).next());
  });

  it('seed 为 0 也不会退化成常量序列', () => {
    const rng = createRng(0);
    const values = [rng.next(), rng.next(), rng.next()];
    expect(new Set(values).size).toBe(3);
  });

  it('输出都在 [0, 1) 区间', () => {
    const rng = createRng(7);
    for (let i = 0; i < 200; i += 1) {
      const v = rng.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('int 落在闭区间内', () => {
    const rng = createRng(9);
    for (let i = 0; i < 200; i += 1) {
      const v = rng.int(3, 7);
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThanOrEqual(7);
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  it('int 在 min > max 时返回 min 而不是 NaN', () => {
    expect(createRng(1).int(5, 2)).toBe(5);
  });

  it('pick 空数组返回 undefined', () => {
    expect(createRng(1).pick([])).toBeUndefined();
  });

  it('pickWeighted 尊重权重', () => {
    const rng = createRng(3);
    let heavy = 0;
    for (let i = 0; i < 500; i += 1) {
      const v = rng.pickWeighted([
        { value: 'a', weight: 90 },
        { value: 'b', weight: 10 },
      ]);
      if (v === 'a') heavy += 1;
    }
    expect(heavy).toBeGreaterThan(400);
  });

  it('shuffle 不改入参', () => {
    const input = [1, 2, 3, 4, 5];
    createRng(1).shuffle(input);
    expect(input).toEqual([1, 2, 3, 4, 5]);
  });

  it('hashSeed 对相同输入稳定、对不同输入区分', () => {
    expect(hashSeed('abc')).toBe(hashSeed('abc'));
    expect(hashSeed('abc')).not.toBe(hashSeed('abd'));
    expect(hashSeed('')).toBeGreaterThanOrEqual(0);
  });
});

// ────────────────────────────── 语义识别 ──────────────────────────────

describe('语义识别', () => {
  // 第三项是字段类型：部分语义规则只对特定类型生效（如 count 只在数字上成立），
  // 类型不符时刻意不识别，避免把字符串字段硬当数量。
  const cases: Array<[string, string, Field['type']]> = [
    ['email', 'email', 'string'],
    ['userEmail', 'email', 'string'],
    ['邮箱', 'email', 'string'],
    ['phone', 'phone', 'string'],
    ['mobileNo', 'phone', 'string'],
    ['avatarUrl', 'imageUrl', 'string'],
    ['website', 'url', 'string'],
    ['ipAddress', 'ip', 'string'],
    ['uuid', 'uuid', 'string'],
    ['color', 'color', 'string'],
    ['address', 'address', 'string'],
    ['companyName', 'company', 'string'],
    ['nickName', 'personName', 'string'],
    ['createdAt', 'timestamp', 'datetime'],
    ['birthday', 'dateOnly', 'date'],
    ['totalAmount', 'amount', 'number'],
    ['progress', 'percent', 'number'],
    ['stockCount', 'count', 'integer'],
    ['age', 'age', 'integer'],
    ['fileName', 'fileName', 'string'],
    ['title', 'title', 'string'],
    ['remark', 'description', 'string'],
    ['orderNo', 'code', 'string'],
    ['deviceName', 'name', 'string'],
    ['deviceId', 'id', 'string'],
  ];

  for (const [name, expected, type] of cases) {
    it(`字段名「${name}」识别为 ${expected}`, () => {
      const field = createField({ name, type });
      expect(detectSemantic(field)).toBe(expected);
    });
  }

  it('类型不符时不识别为数量（字符串字段叫 stockCount 不当数量处理）', () => {
    expect(detectSemantic(createField({ name: 'stockCount', type: 'string' }))).not.toBe('count');
  });

  it('注释也参与识别', () => {
    const field = createField({ name: 'x', type: 'string', comment: '用户手机号' });
    expect(detectSemantic(field)).toBe('phone');
  });

  it('认不出来时返回 unknown，不硬猜', () => {
    const field = createField({ name: 'zzz', type: 'string' });
    expect(detectSemantic(field)).toBe('unknown');
  });

  it('enum 直接返回 enum，不做名称匹配', () => {
    const field = createField({ name: 'email', type: 'enum', constraints: { enumValues: ['A'] } });
    expect(detectSemantic(field)).toBe('enum');
  });

  it('json / object 直接返回 json', () => {
    expect(detectSemantic(createField({ name: 'meta', type: 'json' }))).toBe('json');
    expect(detectSemantic(createField({ name: 'meta', type: 'object' }))).toBe('json');
  });

  it('timestamp 规则只在时间相关类型上生效', () => {
    // boolean 类型即使名字叫 updatedAt 也不该被当成时间
    const field = createField({ name: 'updatedAt', type: 'boolean' });
    expect(detectSemantic(field)).not.toBe('timestamp');
  });
});

// ────────────────────────────── 生成 ──────────────────────────────

function irWithTables(
  tables: Array<{ codeName: string; dbName: string; fields: ReturnType<typeof createField>[] }>,
) {
  const ir = createEmptyIR({ projectName: 'P' });
  const canvas = ir.canvases[0]!;
  const nodes = tables.map((t) =>
    createTableNode({
      name: t.codeName,
      codeName: t.codeName,
      canvasId: canvas.id,
      table: { dbName: t.dbName, fields: t.fields, indexes: [], softDelete: false, timestamps: false },
    }),
  );
  ir.nodes.push(...nodes);
  return { ir, nodes };
}

describe('生成确定性', () => {
  it('同一 IR + 同一 seed，两次生成完全一致', () => {
    const { ir } = buildFixture();
    const a = generateSamples(ir, { seed: 42, rowsPerTable: 5 });
    const b = generateSamples(ir, { seed: 42, rowsPerTable: 5 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('不同 seed 产生不同数据', () => {
    const { ir } = buildFixture();
    const a = generateSamples(ir, { seed: 1, rowsPerTable: 5 });
    const b = generateSamples(ir, { seed: 2, rowsPerTable: 5 });
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it('seed 缺省取 settings.generation.sampleSeed', () => {
    const { ir } = buildFixture();
    expect(generateSamples(ir).seed).toBe(ir.settings.generation.sampleSeed);
  });

  it('逐格独立随机：给表加字段不影响其他字段的值', () => {
    const base = createField({ name: 'alpha', type: 'string' });
    const { ir, nodes } = irWithTables([{ codeName: 'Thing', dbName: 'things', fields: [base] }]);
    const before = generateSamples(ir, { seed: 42, rowsPerTable: 3 }).tables[0]!.rows.map((r) => r['alpha']);

    nodes[0]!.table.fields.push(createField({ name: 'beta', type: 'integer' }));
    const after = generateSamples(ir, { seed: 42, rowsPerTable: 3 }).tables[0]!.rows.map((r) => r['alpha']);

    expect(after).toEqual(before);
  });
});

describe('字段级行为', () => {
  it('field.example 优先于自动生成', () => {
    const field = createField({ name: 'code', type: 'string', example: 'FIXED' });
    const { ir } = irWithTables([{ codeName: 'Thing', dbName: 'things', fields: [field] }]);
    const rows = generateSamples(ir, { rowsPerTable: 2 }).tables[0]!.rows;
    expect(rows.map((r) => r['code'])).toEqual(['FIXED', 'FIXED']);
  });

  it('useFieldExample=false 时忽略 example', () => {
    const field = createField({ name: 'code', type: 'string', example: 'FIXED' });
    const { ir } = irWithTables([{ codeName: 'Thing', dbName: 'things', fields: [field] }]);
    const rows = generateSamples(ir, { rowsPerTable: 1, useFieldExample: false }).tables[0]!.rows;
    expect(rows[0]!['code']).not.toBe('FIXED');
  });

  it('主键用行号，保证唯一且稳定', () => {
    const pk = createField({ name: 'id', type: 'integer' });
    const { ir } = irWithTables([{ codeName: 'Thing', dbName: 'things', fields: [pk] }]);
    const rows = generateSamples(ir, { rowsPerTable: 4 }).tables[0]!.rows;
    expect(rows.map((r) => r['id'])).toEqual([1, 2, 3, 4]);
  });

  it('字符串主键生成带前缀的编号', () => {
    const pk = createField({ name: 'id', type: 'string' });
    const { ir } = irWithTables([{ codeName: 'Thing', dbName: 'things', fields: [pk] }]);
    const rows = generateSamples(ir, { rowsPerTable: 2 }).tables[0]!.rows;
    expect(rows[0]!['id']).toBe('THING-0001');
    expect(rows[1]!['id']).toBe('THING-0002');
  });

  it('enum 字段从字典取值', () => {
    const { ir } = buildFixture();
    const rows = generateSamples(ir, { rowsPerTable: 10 }).tables[0]!.rows;
    const statuses = new Set(rows.map((r) => r['status']));
    for (const s of statuses) expect(['ACTIVE', 'OFFLINE', 'DISABLED']).toContain(s);
  });

  it('enum 没有可选值时置 null 并给 warning', () => {
    const field = createField({ name: 'state', type: 'enum', constraints: { enumValues: [] } });
    const { ir } = irWithTables([{ codeName: 'Thing', dbName: 'things', fields: [field] }]);
    const result = generateSamples(ir, { rowsPerTable: 2 });
    expect(result.tables[0]!.rows[0]!['state']).toBeNull();
    expect(result.warnings.some((w) => w.includes('没有可选值'))).toBe(true);
  });

  it('maxLength 截断', () => {
    const field = createField({ name: 'code', type: 'string', constraints: { maxLength: 3 } });
    const { ir } = irWithTables([{ codeName: 'Thing', dbName: 'things', fields: [field] }]);
    const rows = generateSamples(ir, { rowsPerTable: 3 }).tables[0]!.rows;
    for (const r of rows) expect(String(r['code']).length).toBeLessThanOrEqual(3);
  });

  it('minimum / maximum 裁剪数值', () => {
    const field = createField({ name: 'score', type: 'number', constraints: { minimum: 10, maximum: 20 } });
    const { ir } = irWithTables([{ codeName: 'Thing', dbName: 'things', fields: [field] }]);
    const rows = generateSamples(ir, { rowsPerTable: 10 }).tables[0]!.rows;
    for (const r of rows) {
      const v = r['score'] as number;
      expect(v).toBeGreaterThanOrEqual(10);
      expect(v).toBeLessThanOrEqual(20);
    }
  });

  it('integer 字段产出整数', () => {
    const field = createField({ name: 'count', type: 'integer' });
    const { ir } = irWithTables([{ codeName: 'Thing', dbName: 'things', fields: [field] }]);
    const rows = generateSamples(ir, { rowsPerTable: 10 }).tables[0]!.rows;
    for (const r of rows) expect(Number.isInteger(r['count'])).toBe(true);
  });

  it('date 字段产出 YYYY-MM-DD', () => {
    const field = createField({ name: 'onDate', type: 'date' });
    const { ir } = irWithTables([{ codeName: 'Thing', dbName: 'things', fields: [field] }]);
    const rows = generateSamples(ir, { rowsPerTable: 3 }).tables[0]!.rows;
    for (const r of rows) expect(r['onDate']).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('datetime 字段产出 ISO 8601', () => {
    const field = createField({ name: 'happenedAt', type: 'datetime' });
    const { ir } = irWithTables([{ codeName: 'Thing', dbName: 'things', fields: [field] }]);
    const rows = generateSamples(ir, { rowsPerTable: 3 }).tables[0]!.rows;
    for (const r of rows) expect(r['happenedAt']).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it('array 字段产出数组', () => {
    const field = createField({ name: 'tags', type: 'array', constraints: { arrayItem: 'string' } });
    const { ir } = irWithTables([{ codeName: 'Thing', dbName: 'things', fields: [field] }]);
    const rows = generateSamples(ir, { rowsPerTable: 5 }).tables[0]!.rows;
    for (const r of rows) expect(Array.isArray(r['tags'])).toBe(true);
  });

  it('boolean 字段产出布尔值', () => {
    const field = createField({ name: 'enabled', type: 'boolean' });
    const { ir } = irWithTables([{ codeName: 'Thing', dbName: 'things', fields: [field] }]);
    const rows = generateSamples(ir, { rowsPerTable: 10 }).tables[0]!.rows;
    for (const r of rows) expect(typeof r['enabled']).toBe('boolean');
  });
});

describe('引用完整性', () => {
  it('外键值一定存在于目标表', () => {
    const { deviceTable } = buildFixture();
    const targetPk = deviceTable.table.fields[0]!;

    const ownerField = createField({
      name: 'deviceRef',
      type: 'ref',
      constraints: { ref: { tableId: deviceTable.id, fieldId: targetPk.id } },
    });
    const { ir: ir2 } = irWithTables([{ codeName: 'Order', dbName: 'orders', fields: [ownerField] }]);
    // 把设备表也放进同一个 IR
    ir2.nodes.push(deviceTable);

    const result = generateSamples(ir2, { rowsPerTable: 4 });
    const orders = result.tables.find((t) => t.dbName === 'orders');
    const devices = result.tables.find((t) => t.dbName === 'devices');
    expect(orders).toBeDefined();
    expect(devices).toBeDefined();

    const deviceIds = new Set(devices!.rows.map((r) => r[targetPk.name]));
    for (const row of orders!.rows) expect(deviceIds.has(row['deviceRef'])).toBe(true);
  });

  it('被引用的表先造数（拓扑序）', () => {
    const { deviceTable } = buildFixture();
    const targetPk = deviceTable.table.fields[0]!;
    const ownerField = createField({
      name: 'deviceRef',
      type: 'ref',
      constraints: { ref: { tableId: deviceTable.id, fieldId: targetPk.id } },
    });
    const { ir: ir2 } = irWithTables([{ codeName: 'Order', dbName: 'orders', fields: [ownerField] }]);
    ir2.nodes.push(deviceTable);

    const result = generateSamples(ir2, { rowsPerTable: 3 });
    for (const row of result.tables.find((t) => t.dbName === 'orders')!.rows) {
      expect(row['deviceRef']).not.toBeNull();
    }
  });

  it('外键目标不存在时给 warning 并跳过该字段', () => {
    const field = createField({ name: 'ghost', type: 'ref', constraints: { ref: { tableId: 'nd_MISSING00000' } } });
    const { ir } = irWithTables([{ codeName: 'Thing', dbName: 'things', fields: [field] }]);
    const result = generateSamples(ir, { rowsPerTable: 2 });
    expect(result.warnings.some((w) => w.includes('不存在'))).toBe(true);
  });

  it('自引用外键不崩溃且能指向已有行', () => {
    const ir = createEmptyIR({ projectName: 'P' });
    const canvas = ir.canvases[0]!;
    const pk = createField({ name: 'id', type: 'integer' });
    const table = createTableNode({
      name: 'Node',
      codeName: 'Node',
      canvasId: canvas.id,
      table: { dbName: 'nodes', fields: [pk], indexes: [], softDelete: false, timestamps: false },
    });
    const parent = createField({ name: 'parentId', type: 'integer' });
    // 自引用：指向自己表的主键
    parent.type = 'ref';
    parent.constraints = { ref: { tableId: table.id, fieldId: pk.id } };
    table.table.fields.push(parent);
    ir.nodes.push(table);

    const result = generateSamples(ir, { rowsPerTable: 3 });
    // 自引用是合法的树形结构，不该报「循环引用」警告
    expect(result.warnings.some((w) => w.includes('循环引用'))).toBe(false);
    const rows = result.tables[0]!.rows;
    // 第一行还没有可选父节点，值应为 null 而不是假 ID
    expect(rows[0]!['parentId']).toBeNull();
    // 后续行应指向真实存在的前序行
    const ids = new Set(rows.map((r) => r['id']));
    for (const row of rows.slice(1)) expect(ids.has(row['parentId'])).toBe(true);
  });
});

describe('输出格式', () => {
  it('toSeedJson 按 dbName 分组', () => {
    const { ir } = buildFixture();
    const result = generateSamples(ir, { rowsPerTable: 2 });
    const json = toSeedJson(ir, result);
    expect(Object.keys(json)).toEqual(['devices']);
    expect(json['devices']!.length).toBe(2);
  });

  it('toSeedJson 默认脱敏敏感字段', () => {
    const field = createField({ name: 'password', type: 'string' });
    const { ir } = irWithTables([{ codeName: 'User', dbName: 'users', fields: [field] }]);
    const result = generateSamples(ir, { rowsPerTable: 1 });
    const json = toSeedJson(ir, result);
    expect(json['users']![0]!['password']).toBe('***');
  });

  it('toSeedJson 可关闭脱敏', () => {
    const field = createField({ name: 'password', type: 'string' });
    const { ir } = irWithTables([{ codeName: 'User', dbName: 'users', fields: [field] }]);
    const result = generateSamples(ir, { rowsPerTable: 1 });
    const json = toSeedJson(ir, result, { maskSensitive: false });
    expect(json['users']![0]!['password']).not.toBe('***');
  });

  it('sensitiveFieldWarnings 报告敏感字段', () => {
    const field = createField({ name: 'token', type: 'string' });
    const { ir } = irWithTables([{ codeName: 'User', dbName: 'users', fields: [field] }]);
    const result = generateSamples(ir, { rowsPerTable: 1 });
    expect(sensitiveFieldWarnings(ir, result).join('\n')).toContain('token');
  });
});

describe('行数控制', () => {
  it('rowsPerTable 生效', () => {
    const { ir } = buildFixture();
    expect(generateSamples(ir, { rowsPerTable: 7 }).tables[0]!.rows.length).toBe(7);
  });

  it('rowsPerTable 至少为 1', () => {
    const { ir } = buildFixture();
    expect(generateSamples(ir, { rowsPerTable: 0 }).tables[0]!.rows.length).toBe(1);
  });

  it('没有表的 IR 产出空列表', () => {
    const ir = createEmptyIR({ projectName: 'Empty' });
    const result = generateSamples(ir);
    expect(result.tables).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('按 dbName 字典序输出（与造数顺序解耦）', () => {
    const { ir } = irWithTables([
      { codeName: 'Zeta', dbName: 'zeta', fields: [createField({ name: 'a', type: 'string' })] },
      { codeName: 'Alpha', dbName: 'alpha', fields: [createField({ name: 'b', type: 'string' })] },
    ]);
    expect(generateSamples(ir).tables.map((t) => t.dbName)).toEqual(['alpha', 'zeta']);
  });
});

describe('主键缺失', () => {
  it('表没有主键时给 warning', () => {
    const ir = createEmptyIR({ projectName: 'P' });
    const canvas = ir.canvases[0]!;
    // 主键 = name === 'id' 且 required；这里故意用别的名字且非必填
    const field = createField({ name: 'value', type: 'string', required: false });
    ir.nodes.push(
      createTableNode({
        name: 'T',
        codeName: 'T',
        canvasId: canvas.id,
        table: { dbName: 'ts', fields: [field], indexes: [], softDelete: false, timestamps: false },
      }),
    );
    expect(generateSamples(ir).warnings.some((w) => w.includes('没有主键'))).toBe(true);
  });

  it('有主键时不报主键 warning', () => {
    const pk = createField({ name: 'id', type: 'integer' });
    const { ir } = irWithTables([{ codeName: 'T', dbName: 'ts', fields: [pk] }]);
    expect(generateSamples(ir).warnings.some((w) => w.includes('没有主键'))).toBe(false);
  });
});

void createApiNode;
void newEdgeId;
