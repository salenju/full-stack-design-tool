import { describe, expect, it } from 'vitest';

import {
  buildGraphIndex,
  getApi,
  getField,
  getFieldOwner,
  getNode,
  getPage,
  getTable,
  incomingEdges,
  nodeFieldIdsOf,
  outgoingEdges,
  reachableFromPage,
  sortedApis,
  sortedEnums,
  sortedPages,
  sortedTables,
} from '../src/index.js';
import { buildFixture } from '../src/testing/fixtures.js';

describe('buildGraphIndex', () => {
  it('按 kind 分桶', () => {
    const { ir } = buildFixture();
    const idx = buildGraphIndex(ir);
    expect(idx.tables).toHaveLength(1);
    expect(idx.apis).toHaveLength(2);
    expect(idx.pages).toHaveLength(1);
    expect(idx.notes).toHaveLength(0);
    expect(idx.nodes.size).toBe(4);
  });

  it('字段索引覆盖全部字段（表 + 接口各分区）', () => {
    const { ir, deviceNameField, listApi } = buildFixture();
    const idx = buildGraphIndex(ir);
    expect(idx.fields.has(deviceNameField.id)).toBe(true);
    expect(idx.fields.get(deviceNameField.id)?.ownerNodeId).toBe(idx.tables[0]?.id);

    const queryFieldId = idx.nodeFieldIds.get(listApi.id)?.[0];
    expect(queryFieldId).toBeDefined();
    expect(idx.fields.get(queryFieldId as string)?.partition).toBe('query');
  });

  it('接口响应字段带状态码归属', () => {
    const { ir, listApi } = buildFixture();
    const idx = buildGraphIndex(ir);
    const ids = idx.apiResponseFieldIds.get(listApi.id) ?? [];
    expect(ids).toHaveLength(4);
    const first = ids[0] as string;
    expect(idx.fields.get(first)?.partition).toBe('response');
    expect(idx.fields.get(first)?.responseStatus).toBe(200);
  });

  it('组件索引带所属页面', () => {
    const { ir, listPage } = buildFixture();
    const idx = buildGraphIndex(ir);
    expect(idx.components.size).toBe(2);
    for (const loc of idx.components.values()) {
      expect(loc.pageNodeId).toBe(listPage.id);
    }
  });

  it('主键识别：id 字段优先，其次唯一索引', () => {
    const { ir, deviceTable, deviceIdField } = buildFixture();
    const idx = buildGraphIndex(ir);
    expect(idx.primaryKey.get(deviceTable.id)?.id).toBe(deviceIdField.id);
  });

  it('edgesByNode 双向登记', () => {
    const { ir } = buildFixture();
    const idx = buildGraphIndex(ir);
    for (const list of idx.edgesByNode.values()) {
      expect(list.length).toBeGreaterThan(0);
    }
    expect([...idx.edgesByNode.values()].reduce((n, l) => n + l.length, 0)).toBe(ir.edges.length * 2);
  });

  it('枚举与模型字典入索引', () => {
    const { ir } = buildFixture();
    const idx = buildGraphIndex(ir);
    expect(idx.enums.size).toBe(1);
    expect(idx.models.size).toBe(0);
  });
});

describe('按 ID 取节点', () => {
  it('各类型查询正确命中', () => {
    const { ir, deviceTable, listApi, listPage } = buildFixture();
    expect(getNode(ir, deviceTable.id)?.kind).toBe('table');
    expect(getTable(ir, deviceTable.id)?.id).toBe(deviceTable.id);
    expect(getApi(ir, listApi.id)?.id).toBe(listApi.id);
    expect(getPage(ir, listPage.id)?.id).toBe(listPage.id);
  });

  it('类型不匹配返回 undefined', () => {
    const { ir, deviceTable, listApi } = buildFixture();
    expect(getApi(ir, deviceTable.id)).toBeUndefined();
    expect(getTable(ir, listApi.id)).toBeUndefined();
  });

  it('不存在的 ID 返回 undefined', () => {
    const { ir } = buildFixture();
    expect(getNode(ir, 'nd_ZZZZZZZZZZZZ')).toBeUndefined();
  });
});

describe('getField / getFieldOwner', () => {
  it('能在表与接口里找到字段', () => {
    const { ir, deviceIdField, listApi } = buildFixture();
    expect(getField(ir, deviceIdField.id)?.name).toBe('deviceId');
    const idx = buildGraphIndex(ir);
    const apiFieldId = idx.nodeFieldIds.get(listApi.id)?.[0] as string;
    expect(getField(ir, apiFieldId)).toBeDefined();
  });

  it('能定位字段所属节点', () => {
    const { ir, statusField, deviceTable } = buildFixture();
    expect(getFieldOwner(ir, statusField.id)?.id).toBe(deviceTable.id);
  });

  it('不存在的字段返回 undefined', () => {
    const { ir } = buildFixture();
    expect(getField(ir, 'fd_ZZZZZZZZZZZZ')).toBeUndefined();
    expect(getFieldOwner(ir, 'fd_ZZZZZZZZZZZZ')).toBeUndefined();
  });
});

describe('nodeFieldIdsOf', () => {
  it('表返回全部字段', () => {
    const { ir, deviceTable } = buildFixture();
    expect(nodeFieldIdsOf(ir, deviceTable)).toHaveLength(4);
  });

  it('接口汇总 pathParams/query/headers/body/response', () => {
    const { ir, listApi } = buildFixture();
    // fixture: 2 query + 4 response
    expect(nodeFieldIdsOf(ir, listApi)).toHaveLength(6);
  });

  it('页面与备注无字段', () => {
    const { ir, listPage } = buildFixture();
    expect(nodeFieldIdsOf(ir, listPage)).toEqual([]);
  });
});

describe('稳定排序（保证产物可复现）', () => {
  it('表按 dbName 排序', () => {
    const { ir } = buildFixture();
    const names = sortedTables(ir).map((t) => t.table.dbName);
    expect([...names].sort()).toEqual(names);
  });

  it('接口按 path 再按 method 排序', () => {
    const { ir } = buildFixture();
    const list = sortedApis(ir).map((a) => `${a.api.path} ${a.api.method}`);
    expect(list).toEqual(['/devices GET', '/devices POST']);
  });

  it('页面按 route 排序', () => {
    const { ir } = buildFixture();
    const routes = sortedPages(ir).map((p) => p.page.route);
    expect([...routes].sort()).toEqual(routes);
  });

  it('枚举按 name 排序', () => {
    const { ir } = buildFixture();
    expect(sortedEnums(ir)).toHaveLength(1);
  });

  it('多次调用结果一致', () => {
    const { ir } = buildFixture();
    expect(sortedApis(ir).map((a) => a.id)).toEqual(sortedApis(ir).map((a) => a.id));
  });
});

describe('边查询', () => {
  it('outgoingEdges 按方向过滤', () => {
    const { ir, listApi, listPage } = buildFixture();
    expect(outgoingEdges(ir, listPage.id)).toHaveLength(1);
    expect(outgoingEdges(ir, listApi.id)).toHaveLength(1);
    expect(outgoingEdges(ir, listPage.id)[0]?.kind).toBe('call');
  });

  it('incomingEdges 按方向过滤', () => {
    const { ir, listApi } = buildFixture();
    expect(incomingEdges(ir, listApi.id)).toHaveLength(1);
    expect(incomingEdges(ir, listApi.id)[0]?.kind).toBe('call');
  });

  it('可按 kind 过滤', () => {
    const { ir, deviceTable } = buildFixture();
    expect(incomingEdges(ir, deviceTable.id, 'read')).toHaveLength(1);
    expect(incomingEdges(ir, deviceTable.id, 'write')).toHaveLength(1);
    expect(incomingEdges(ir, deviceTable.id, 'navigate')).toHaveLength(0);
  });
});

describe('reachableFromPage 流程闭包', () => {
  it('从列表页可达调用接口与读取的表', () => {
    const { ir, listPage, listApi, deviceTable } = buildFixture();
    const sub = reachableFromPage(ir, listPage.id);
    expect(sub.pageIds).toContain(listPage.id);
    expect(sub.apiIds).toContain(listApi.id);
    expect(sub.tableIds).toContain(deviceTable.id);
  });

  it('未连线的接口不在闭包内（创建接口没有 call 边）', () => {
    const { ir, listPage, createApi } = buildFixture();
    const sub = reachableFromPage(ir, listPage.id);
    expect(sub.apiIds).not.toContain(createApi.id);
  });

  it('沿 navigate 边可达其他页面', () => {
    const { ir, listPage, createApi } = buildFixture();
    const detailPage = {
      id: 'nd_DETAILPAGE01',
      kind: 'page' as const,
      name: '设备详情页',
      codeName: 'DeviceDetail',
      canvasId: ir.canvases[0]?.id ?? '',
      position: { x: 0, y: 0 },
      size: { w: 300, h: 200 },
      collapsed: false,
      tags: [],
      page: { route: '/devices/:id', title: '详情', layout: 'detail' as const, components: [] },
    };
    ir.nodes.push(detailPage);
    ir.edges.push({
      id: 'ed_NAVIGATE0001',
      kind: 'navigate',
      canvasId: ir.canvases[0]?.id ?? '',
      source: { nodeId: listPage.id },
      target: { nodeId: detailPage.id },
    });
    const sub = reachableFromPage(ir, listPage.id);
    expect(sub.pageIds).toContain(detailPage.id);
    expect(sub.apiIds).not.toContain(createApi.id);
  });

  it('沿 map 边把字段纳入闭包', () => {
    const { ir, listPage, deviceNameField } = buildFixture();
    ir.edges.push({
      id: 'ed_MAP00000001',
      kind: 'map',
      canvasId: ir.canvases[0]?.id ?? '',
      source: { nodeId: listPage.id, fieldId: deviceNameField.id },
      target: { nodeId: listPage.id, fieldId: deviceNameField.id },
    });
    const sub = reachableFromPage(ir, listPage.id);
    expect(sub.fieldIds).toContain(deviceNameField.id);
  });

  it('不存在的页面返回只含自身的闭包', () => {
    const { ir } = buildFixture();
    const sub = reachableFromPage(ir, 'nd_ZZZZZZZZZZZZ');
    expect(sub.apiIds).toEqual([]);
    expect(sub.tableIds).toEqual([]);
  });
});
