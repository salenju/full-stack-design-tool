import { buildFixture } from '@fsdt/core-ir/testing';
import { describe, expect, it } from 'vitest';

import { generateSamples } from '../src/generate.js';
import { toHttpFile, toPostmanCollection, toSeedSql } from '../src/exports.js';

function fixtureWithSamples() {
  const fixture = buildFixture();
  const result = generateSamples(fixture.ir, { seed: 7, rowsPerTable: 3 });
  return { ...fixture, result };
}

describe('toHttpFile', () => {
  it('每个接口一节，带 method、完整 URL 与查询串', () => {
    const { ir, result } = fixtureWithSamples();
    const text = toHttpFile(ir, result);

    expect(text).toContain('### 查询设备列表');
    expect(text).toContain('GET http://localhost:3000/api/devices?');
    expect(text).toContain('### 创建设备');
    expect(text).toContain('POST http://localhost:3000/api/devices');
  });

  it('带请求体的接口写出 JSON body 与 Content-Type', () => {
    const { ir, result } = fixtureWithSamples();
    const text = toHttpFile(ir, result);
    const createSection = text.slice(text.indexOf('### 创建设备'));

    expect(createSection).toContain('Content-Type: application/json');
    expect(createSection).toContain('"deviceName"');
  });

  it('baseUrl 可覆盖，且不重复拼 /api', () => {
    const { ir, result } = fixtureWithSamples();
    const text = toHttpFile(ir, result, { baseUrl: 'https://api.example.com', apiPrefix: '/v2' });
    expect(text).toContain('https://api.example.com/v2/devices');
    expect(text).not.toContain('/api/api');
  });

  it('同一 seed 两次生成完全一致', () => {
    const { ir } = fixtureWithSamples();
    const a = toHttpFile(ir, generateSamples(ir, { seed: 7, rowsPerTable: 3 }));
    const b = toHttpFile(ir, generateSamples(ir, { seed: 7, rowsPerTable: 3 }));
    expect(a).toBe(b);
  });
});

describe('toPostmanCollection', () => {
  it('输出 Postman v2.1 结构，item 数等于接口数', () => {
    const { ir, result } = fixtureWithSamples();
    const collection = toPostmanCollection(ir, result);

    expect(collection.info.schema).toContain('v2.1.0');
    const apiCount = ir.nodes.filter((n) => n.kind === 'api').length;
    expect(collection.item.length).toBe(apiCount);
  });

  it('有请求体的接口生成 raw JSON body，没有的不生成', () => {
    const { ir, result } = fixtureWithSamples();
    const collection = toPostmanCollection(ir, result);

    const post = collection.item.find((i) => i.request.method === 'POST');
    const get = collection.item.find((i) => i.request.method === 'GET');
    expect(post?.request.body?.mode).toBe('raw');
    expect(post?.request.body?.options.raw.language).toBe('json');
    expect(get?.request.body).toBeUndefined();
  });

  it('baseUrl 走 collection 变量，而不是硬编码进每条请求', () => {
    const { ir, result } = fixtureWithSamples();
    const collection = toPostmanCollection(ir, result, { baseUrl: 'https://api.example.com' });

    expect(collection.variable).toContainEqual({ key: 'baseUrl', value: 'https://api.example.com/api' });
    expect(collection.item[0]?.request.url.host).toEqual(['{{baseUrl}}']);
  });

  it('GET 的 query 参数进 url.query 且 raw 里带查询串', () => {
    const { ir, result } = fixtureWithSamples();
    const collection = toPostmanCollection(ir, result);
    const get = collection.item.find((i) => i.request.method === 'GET');

    expect(get?.request.url.query?.some((q) => q.key === 'page')).toBe(true);
    expect(get?.request.url.raw).toContain('page=1');
  });
});

describe('toSeedSql', () => {
  it('每张表一条 INSERT，列名按 naming 设置推导并加双引号', () => {
    const { ir, result } = fixtureWithSamples();
    const sql = toSeedSql(ir, result);

    expect(sql).toContain('INSERT INTO "devices"');
    // fixture 的 fieldCase 是 camel，所以列名保持 deviceId；有 dbName 时优先用 dbName
    expect(sql).toContain('"deviceId"');
    expect(sql).toContain('"createdAt"');
  });

  it('字符串里的单引号被转义成两个，避免语法错误', () => {
    const { ir, result } = fixtureWithSamples();
    // 直接改第一行的值：这比造一份带引号的 IR 更直接
    const first = result.tables[0]?.rows[0];
    if (first === undefined) throw new Error('需要至少一行数据');
    first['deviceName'] = "O'Brien 设备";

    const sql = toSeedSql(ir, result);
    expect(sql).toContain("'O''Brien 设备'");
    // 没有裸单引号造成的断句
    expect(sql).not.toContain("'O'Brien");
  });

  it('null 写成 NULL，不写成空字符串', () => {
    const { ir, result } = fixtureWithSamples();
    const row = result.tables[0]?.rows[0];
    if (row === undefined) throw new Error('需要至少一行数据');
    row['deviceName'] = null;

    const sql = toSeedSql(ir, result);
    expect(sql).toContain('NULL');
    // 空值不能变成 '' —— 那在库里是一个合法的空字符串，与 null 语义不同
    expect(sql).not.toContain("''");
  });

  it('identifier 引号可关闭', () => {
    const { ir, result } = fixtureWithSamples();
    const sql = toSeedSql(ir, result, { quoteIdentifiers: false });
    expect(sql).toContain('INSERT INTO devices');
  });

  it('行数超过批量上限时拆成多条 INSERT', () => {
    const { ir } = fixtureWithSamples();
    const many = generateSamples(ir, { seed: 7, rowsPerTable: 5 });
    const sql = toSeedSql(ir, many, { rowsPerStatement: 2 });
    const inserts = sql.match(/INSERT INTO/g)?.length ?? 0;
    expect(inserts).toBeGreaterThan(1);
  });

  it('带软删除的表在注释里说明', () => {
    const { ir } = fixtureWithSamples();
    const table = ir.nodes.find((n) => n.kind === 'table');
    if (table === undefined || table.kind !== 'table') throw new Error('需要表节点');
    table.table.softDelete = true;
    const sql = toSeedSql(ir, generateSamples(ir, { seed: 1, rowsPerTable: 2 }));
    expect(sql).toContain('软删除');
  });
});
