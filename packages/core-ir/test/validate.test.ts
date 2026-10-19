import { describe, expect, it } from 'vitest';

import {
  assertValidIR,
  createApiNode,
  createField,
  createPageNode,
  createTableNode,
  getEdgeIdsOf,
  IRValidationError,
  isDiagnostic,
  newEdgeId,
  validateIR,
  type IR,
  type IREdge,
} from '../src/index.js';
import { buildFixture, cloneIR, danglingNodeId } from '../src/testing/fixtures.js';

/** 便捷：取某 code 的诊断 */
function codes(ir: IR): string[] {
  return validateIR(ir).map((d) => d.code);
}

function addEdge(ir: IR, edge: Partial<IREdge> & Pick<IREdge, 'kind' | 'source' | 'target'>): IREdge {
  const canvasId = ir.canvases[0]?.id ?? '';
  const full: IREdge = { id: newEdgeId(), canvasId, ...edge };
  ir.edges.push(full);
  return full;
}

describe('validateIR 正常路径', () => {
  it('合法 fixture 无 error 级诊断', () => {
    const { ir } = buildFixture();
    const errors = validateIR(ir).filter((d) => d.severity === 'error');
    expect(errors).toEqual([]);
  });

  it('合法 fixture 会给出「表无主键」类提示前先有唯一索引，故不报 IR011', () => {
    const { ir } = buildFixture();
    expect(codes(ir)).not.toContain('IR011');
  });

  it('诊断对象形状可判别', () => {
    const { ir } = buildFixture();
    ir.nodes[0]!.canvasId = 'cv_ZZZZZZZZZZZZ';
    const diags = validateIR(ir);
    expect(diags.length).toBeGreaterThan(0);
    expect(diags.every(isDiagnostic)).toBe(true);
    const first = diags[0]!;
    expect(['info', 'warn', 'error']).toContain(first.severity);
    expect(typeof first.message).toBe('string');
    expect(first.code).toMatch(/^IR\d{3}$/);
  });
});

describe('IR001 画布引用', () => {
  it('节点指向不存在的画布 → error', () => {
    const { ir } = buildFixture();
    ir.nodes[0]!.canvasId = 'cv_NOTEXIST0000';
    expect(codes(ir)).toContain('IR001');
  });

  it('连线指向不存在的画布 → error', () => {
    const { ir } = buildFixture();
    ir.edges[0]!.canvasId = 'cv_NOTEXIST0000';
    expect(codes(ir)).toContain('IR001');
  });
});

describe('IR002 ID 唯一性', () => {
  it('节点 ID 重复 → error', () => {
    const { ir } = buildFixture();
    ir.nodes[1]!.id = ir.nodes[0]!.id;
    expect(codes(ir)).toContain('IR002');
  });

  it('字段 ID 重复（表与接口之间）→ error', () => {
    const { ir, deviceIdField, listApi } = buildFixture();
    const api = ir.nodes.find((n) => n.id === listApi.id);
    if (api?.kind !== 'api') throw new Error('接口丢失');
    const body = api.api.responses[0]!.fields[0]!;
    body.id = deviceIdField.id;
    expect(codes(ir)).toContain('IR002');
  });

  it('连线 ID 重复 → error', () => {
    const { ir } = buildFixture();
    ir.edges[1]!.id = ir.edges[0]!.id;
    expect(codes(ir)).toContain('IR002');
  });

  it('组件 ID 重复 → error', () => {
    const { ir, listPage } = buildFixture();
    const page = ir.nodes.find((n) => n.id === listPage.id);
    if (page?.kind !== 'page') throw new Error('页面丢失');
    const [a, b] = page.page.components;
    if (a === undefined || b === undefined) throw new Error('组件不足');
    b.id = a.id;
    expect(codes(ir)).toContain('IR002');
  });
});

describe('IR003 枚举引用', () => {
  it('引用不存在的枚举 → error', () => {
    const { ir, statusField } = buildFixture();
    for (const node of ir.nodes) {
      if (node.kind !== 'table') continue;
      const f = node.table.fields.find((x) => x.id === statusField.id);
      if (f !== undefined) f.constraints = { enumRef: 'en_NOTEXIST0000' };
    }
    expect(codes(ir)).toContain('IR003');
  });

  it('枚举字段既无 enumRef 也无内联值 → error', () => {
    const { ir } = buildFixture();
    ir.nodes.push(
      createTableNode({
        name: '坏表',
        canvasId: ir.canvases[0]?.id ?? '',
        table: {
          dbName: 'bad',
          fields: [createField({ name: 'state', type: 'enum', constraints: {} })],
          indexes: [],
          softDelete: false,
          timestamps: false,
        },
      }),
    );
    expect(codes(ir)).toContain('IR003');
  });

  it('内联枚举取值合法 → 不报错', () => {
    const { ir } = buildFixture();
    ir.nodes.push(
      createTableNode({
        name: '内联枚举表',
        canvasId: ir.canvases[0]?.id ?? '',
        table: {
          dbName: 'inline_enum',
          fields: [
            createField({ name: 'level', type: 'enum', constraints: { enumValues: ['LOW', 'HIGH'] } }),
          ],
          indexes: [],
          softDelete: false,
          timestamps: false,
        },
      }),
    );
    expect(codes(ir)).not.toContain('IR003');
  });
});

describe('IR004 外键目标', () => {
  it('ref 字段缺少 ref 约束 → error', () => {
    const { ir } = buildFixture();
    ir.nodes.push(
      createTableNode({
        name: '子表',
        canvasId: ir.canvases[0]?.id ?? '',
        table: {
          dbName: 'children',
          fields: [createField({ name: 'deviceRef', type: 'ref' })],
          indexes: [],
          softDelete: false,
          timestamps: false,
        },
      }),
    );
    expect(codes(ir)).toContain('IR004');
  });

  it('ref 指向不存在的表 → error', () => {
    const { ir } = buildFixture();
    ir.nodes.push(
      createTableNode({
        name: '子表',
        canvasId: ir.canvases[0]?.id ?? '',
        table: {
          dbName: 'children',
          fields: [
            createField({
              name: 'deviceRef',
              type: 'ref',
              constraints: { ref: { tableId: 'nd_ZZZZZZZZZZZZ' } },
            }),
          ],
          indexes: [],
          softDelete: false,
          timestamps: false,
        },
      }),
    );
    expect(codes(ir)).toContain('IR004');
  });

  it('ref 指向存在表的合法字段 → 不报错', () => {
    const { ir, deviceTable, deviceIdField } = buildFixture();
    ir.nodes.push(
      createTableNode({
        name: '日志表',
        canvasId: ir.canvases[0]?.id ?? '',
        table: {
          dbName: 'device_logs',
          fields: [
            createField({
              name: 'deviceId',
              type: 'ref',
              constraints: { ref: { tableId: deviceTable.id, fieldId: deviceIdField.id } },
            }),
          ],
          indexes: [],
          softDelete: false,
          timestamps: false,
        },
      }),
    );
    expect(codes(ir)).not.toContain('IR004');
  });
});

describe('IR005 连线合法性', () => {
  it('起点节点不存在 → error', () => {
    const { ir, listApi } = buildFixture();
    addEdge(ir, { kind: 'read', source: { nodeId: danglingNodeId() }, target: { nodeId: listApi.id } });
    expect(codes(ir)).toContain('IR005');
  });

  it('终点节点不存在 → error', () => {
    const { ir, listApi } = buildFixture();
    addEdge(ir, { kind: 'read', source: { nodeId: listApi.id }, target: { nodeId: danglingNodeId() } });
    expect(codes(ir)).toContain('IR005');
  });

  it('write 连线起点不能是表（表不会写表）→ error', () => {
    const { ir, deviceTable } = buildFixture();
    addEdge(ir, { kind: 'write', source: { nodeId: deviceTable.id }, target: { nodeId: deviceTable.id } });
    expect(codes(ir)).toContain('IR005');
  });

  it('call 连线终点必须是接口 → error', () => {
    const { ir, listPage, deviceTable } = buildFixture();
    addEdge(ir, { kind: 'call', source: { nodeId: listPage.id }, target: { nodeId: deviceTable.id } });
    expect(codes(ir)).toContain('IR005');
  });

  it('navigate 只能页面到页面 → error', () => {
    const { ir, listPage, listApi } = buildFixture();
    addEdge(ir, { kind: 'navigate', source: { nodeId: listPage.id }, target: { nodeId: listApi.id } });
    expect(codes(ir)).toContain('IR005');
  });

  it('map 允许表到接口、接口到表等互通', () => {
    const { ir, deviceTable, listApi } = buildFixture();
    const before = codes(ir).filter((c) => c === 'IR005').length;
    addEdge(ir, { kind: 'map', source: { nodeId: deviceTable.id }, target: { nodeId: listApi.id } });
    const after = codes(ir).filter((c) => c === 'IR005').length;
    expect(after).toBe(before);
  });

  it('起点字段不存在 → error', () => {
    const { ir, listApi } = buildFixture();
    addEdge(ir, {
      kind: 'read',
      source: { nodeId: listApi.id, fieldId: 'fd_ZZZZZZZZZZZZ' },
      target: { nodeId: listApi.id },
    });
    expect(codes(ir)).toContain('IR005');
  });

  it('非 map 连线自连 → warn（不阻断，但提示）', () => {
    const { ir, listApi } = buildFixture();
    addEdge(ir, { kind: 'call', source: { nodeId: listApi.id }, target: { nodeId: listApi.id } });
    const selfLoop = validateIR(ir).find((d) => d.message.includes('自连'));
    expect(selfLoop?.severity).toBe('warn');
  });
});

describe('IR006 组件引用完整性', () => {
  it('组件 apiRef 指向不存在的接口 → error', () => {
    const { ir, listPage } = buildFixture();
    const page = ir.nodes.find((n) => n.id === listPage.id);
    if (page?.kind !== 'page') throw new Error('页面丢失');
    const table = page.page.components.find((c) => c.type === 'table');
    if (table?.type !== 'table') throw new Error('表格丢失');
    table.apiRef = 'nd_ZZZZZZZZZZZZ';
    expect(codes(ir)).toContain('IR006');
  });

  it('tabs 引用不存在的子组件 → error', () => {
    const { ir, listPage } = buildFixture();
    const page = ir.nodes.find((n) => n.id === listPage.id);
    if (page?.kind !== 'page') throw new Error('页面丢失');
    page.page.components.push({
      id: 'cp_TABS00000000',
      type: 'tabs',
      bindings: [],
      tabs: [{ key: 'a', label: '页签', componentIds: ['cp_MISSING00000'] }],
    });
    expect(codes(ir)).toContain('IR006');
  });

  it('绑定字段不存在 → error', () => {
    const { ir, listPage } = buildFixture();
    const page = ir.nodes.find((n) => n.id === listPage.id);
    if (page?.kind !== 'page') throw new Error('页面丢失');
    const form = page.page.components.find((c) => c.type === 'searchForm');
    if (form === undefined) throw new Error('搜索表单丢失');
    form.bindings.push({ fieldRef: 'fd_ZZZZZZZZZZZZ' });
    expect(codes(ir)).toContain('IR006');
  });

  it('表格列绑定不存在的字段 → error', () => {
    const { ir, listPage } = buildFixture();
    const page = ir.nodes.find((n) => n.id === listPage.id);
    if (page?.kind !== 'page') throw new Error('页面丢失');
    const table = page.page.components.find((c) => c.type === 'table');
    if (table?.type !== 'table') throw new Error('表格丢失');
    table.columns.push({ fieldRef: 'fd_ZZZZZZZZZZZZ' });
    expect(codes(ir)).toContain('IR006');
  });

  it('动作指向不存在的路由 → error', () => {
    const { ir, listPage, listApi } = buildFixture();
    const page = ir.nodes.find((n) => n.id === listPage.id);
    if (page?.kind !== 'page') throw new Error('页面丢失');
    const table = page.page.components.find((c) => c.type === 'table');
    if (table?.type !== 'table') throw new Error('表格丢失');
    table.rowActions.push({
      id: 'cp_ACTION000000',
      type: 'action',
      bindings: [],
      trigger: { event: 'click' },
      apiRef: listApi.id,
      navigateTo: '/not-exists',
    });
    expect(codes(ir)).toContain('IR006');
  });

  it('动作指向已存在路由 → 不报错', () => {
    const { ir, listPage, listApi } = buildFixture();
    const page = ir.nodes.find((n) => n.id === listPage.id);
    if (page?.kind !== 'page') throw new Error('页面丢失');
    const table = page.page.components.find((c) => c.type === 'table');
    if (table?.type !== 'table') throw new Error('表格丢失');
    table.rowActions.push({
      id: 'cp_ACTION000001',
      type: 'action',
      bindings: [],
      trigger: { event: 'click' },
      apiRef: listApi.id,
      navigateTo: '/devices',
    });
    expect(codes(ir)).not.toContain('IR006');
  });
});

describe('IR007 路径参数一致性', () => {
  it('路径里有占位符但未声明 pathParams → error', () => {
    const { ir, listApi } = buildFixture();
    const api = ir.nodes.find((n) => n.id === listApi.id);
    if (api?.kind !== 'api') throw new Error('接口丢失');
    api.api.path = '/devices/{deviceId}';
    expect(codes(ir)).toContain('IR007');
  });

  it('声明了 pathParams 但路径无占位符 → warn', () => {
    const { ir, listApi } = buildFixture();
    const api = ir.nodes.find((n) => n.id === listApi.id);
    if (api?.kind !== 'api') throw new Error('接口丢失');
    api.api.pathParams.push(createField({ name: 'id', type: 'string' }));
    const warn = validateIR(ir).find((d) => d.code === 'IR007');
    expect(warn?.severity).toBe('warn');
  });

  it('占位符与声明完全一致 → 不报错', () => {
    const { ir, listApi } = buildFixture();
    const api = ir.nodes.find((n) => n.id === listApi.id);
    if (api?.kind !== 'api') throw new Error('接口丢失');
    api.api.path = '/devices/{deviceId}';
    api.api.pathParams.push(createField({ name: 'deviceId', type: 'string' }));
    expect(codes(ir)).not.toContain('IR007');
  });
});

describe('IR008 接口路由重复', () => {
  it('同 method + 同 path → error', () => {
    const { ir, listApi } = buildFixture();
    const dup = createApiNode({
      name: '重复接口',
      canvasId: ir.canvases[0]?.id ?? '',
      api: {
        method: 'GET',
        path: '/devices',
        summary: '重复',
        tags: [],
        auth: 'none',
        pathParams: [],
        query: [],
        headers: [],
        responses: [{ status: 200, description: 'ok', fields: [], shape: 'empty' }],
      },
    });
    ir.nodes.push(dup);
    expect(codes(ir)).toContain('IR008');
    expect(dup.id).not.toBe(listApi.id);
  });

  it('不同 method 同 path 合法', () => {
    const { ir, listApi } = buildFixture();
    const api = ir.nodes.find((n) => n.id === listApi.id);
    if (api?.kind !== 'api') throw new Error('接口丢失');
    // fixture 里已有 POST /devices，GET 与 POST 并存合法
    expect(codes(ir)).not.toContain('IR008');
  });
});

describe('IR009 页面路由重复', () => {
  it('两个页面同路由 → error', () => {
    const { ir } = buildFixture();
    ir.nodes.push(createPageNode({ name: '重复页', canvasId: ir.canvases[0]?.id ?? '', page: {
      route: '/devices',
      title: '重复',
      layout: 'blank',
      components: [],
    } }));
    expect(codes(ir)).toContain('IR009');
  });
});

describe('IR010 codeName 冲突', () => {
  it('表/页面 codeName 重复 → error（会生成同名类型）', () => {
    const { ir, listPage } = buildFixture();
    ir.nodes.push(
      createTableNode({
        name: '同名表',
        codeName: 'DeviceList',
        canvasId: ir.canvases[0]?.id ?? '',
        table: { dbName: 'dl', fields: [], indexes: [], softDelete: false, timestamps: false },
      }),
    );
    expect(ir.nodes.some((n) => n.id === listPage.id)).toBe(true);
    expect(codes(ir)).toContain('IR010');
  });

  it('接口 operationId 允许重复（不报 IR010）', () => {
    const { ir } = buildFixture();
    ir.nodes.push(
      createApiNode({
        name: '同 op 接口',
        codeName: 'listDevices',
        canvasId: ir.canvases[0]?.id ?? '',
        api: {
          method: 'POST',
          path: '/other',
          summary: 'x',
          tags: [],
          auth: 'none',
          pathParams: [],
          query: [],
          headers: [],
          responses: [{ status: 200, description: 'ok', fields: [], shape: 'empty' }],
        },
      }),
    );
    expect(codes(ir)).not.toContain('IR010');
  });
});

describe('IR011 / IR012 提示类', () => {
  it('表无主键也无唯一索引 → warn', () => {
    const { ir } = buildFixture();
    ir.nodes.push(
      createTableNode({
        name: '无主键表',
        canvasId: ir.canvases[0]?.id ?? '',
        table: { dbName: 'no_pk', fields: [createField({ name: 'title' })], indexes: [], softDelete: false, timestamps: false },
      }),
    );
    const hit = validateIR(ir).find((d) => d.code === 'IR011');
    expect(hit?.severity).toBe('warn');
  });

  it('表格列展示敏感字段 → warn', () => {
    const { ir, listPage } = buildFixture();
    const page = ir.nodes.find((n) => n.id === listPage.id);
    if (page?.kind !== 'page') throw new Error('页面丢失');
    const table = page.page.components.find((c) => c.type === 'table');
    if (table?.type !== 'table') throw new Error('表格丢失');
    const col = table.columns[0];
    if (col === undefined) throw new Error('列丢失');
    for (const node of ir.nodes) {
      if (node.kind !== 'table') continue;
      const f = node.table.fields.find((x) => x.id === col.fieldRef);
      if (f !== undefined) f.sensitive = true;
    }
    const hit = validateIR(ir).find((d) => d.code === 'IR012');
    expect(hit?.severity).toBe('warn');
  });
});

describe('assertValidIR', () => {
  it('合法 IR 不抛', () => {
    const { ir } = buildFixture();
    expect(() => assertValidIR(ir)).not.toThrow();
  });

  it('有 error 时抛 IRValidationError 且带上诊断', () => {
    const { ir } = buildFixture();
    ir.nodes[0]!.canvasId = 'cv_NOTEXIST0000';
    try {
      assertValidIR(ir);
      throw new Error('应当抛错');
    } catch (err) {
      expect(err).toBeInstanceOf(IRValidationError);
      const e = err as IRValidationError;
      expect(e.diagnostics.length).toBeGreaterThan(0);
      expect(e.diagnostics.every((d) => d.severity === 'error')).toBe(true);
      expect(e.message).toContain('IR001');
    }
  });

  it('只有 warn 时不抛（warn 不阻断生成）', () => {
    const { ir } = buildFixture();
    ir.nodes.push(
      createTableNode({
        name: '无主键表',
        canvasId: ir.canvases[0]?.id ?? '',
        table: { dbName: 'no_pk', fields: [createField({ name: 'x' })], indexes: [], softDelete: false, timestamps: false },
      }),
    );
    expect(validateIR(ir).some((d) => d.severity === 'warn')).toBe(true);
    expect(() => assertValidIR(ir)).not.toThrow();
  });
});

describe('getEdgeIdsOf', () => {
  it('返回与节点相连的所有边（入 + 出）', () => {
    const { ir, listApi, listPage, deviceTable } = buildFixture();
    expect(getEdgeIdsOf(ir, listApi.id)).toHaveLength(2);
    expect(getEdgeIdsOf(ir, listPage.id)).toHaveLength(1);
    expect(getEdgeIdsOf(ir, deviceTable.id)).toHaveLength(2);
  });
});

describe('校验不修改入参', () => {
  it('validateIR 是纯函数', () => {
    const { ir } = buildFixture();
    const snapshot = JSON.stringify(cloneIR(ir));
    validateIR(ir);
    expect(JSON.stringify(ir)).toBe(snapshot);
  });
});
