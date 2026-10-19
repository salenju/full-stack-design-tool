import { createApiNode, createEmptyIR, createField, createForm, createPageNode, createSearchForm, createTable, createTableNode, newEdgeId } from '@fsdt/core-ir';
import { buildFixture } from '@fsdt/core-ir/testing';
import { describe, expect, it } from 'vitest';

import { emitUiSchema } from '../src/index.js';

function firstPage(ir: Parameters<typeof emitUiSchema>[0]) {
  const { pages } = emitUiSchema(ir);
  expect(pages.length).toBeGreaterThan(0);
  return pages[0]!;
}

describe('页面基本结构', () => {
  it('产出页面路由、标题与组件名', () => {
    const { ir } = buildFixture();
    const page = firstPage(ir);
    expect(page.route).toBe('/devices');
    expect(page.title).toBe('设备列表');
    expect(page.componentName).toBe('DeviceList');
    expect(page.layout).toBe('list');
  });

  it('suggestPath 按路由推导，便于生成器直接落盘', () => {
    const { ir } = buildFixture();
    expect(firstPage(ir).suggestPath).toBe('src/views/devices.vue');
  });

  it('routePrefix 生效且不与路由双斜杠', () => {
    const { ir } = buildFixture();
    const { pages } = emitUiSchema(ir, { routePrefix: '/admin' });
    expect(pages[0]!.route).toBe('/admin/devices');
  });

  it('viewsDir 可覆盖', () => {
    const { ir } = buildFixture();
    const { pages } = emitUiSchema(ir, { viewsDir: 'src/pages' });
    expect(pages[0]!.suggestPath).toBe('src/pages/devices.vue');
  });

  it('多页面按路由字典序输出（保证生成结果稳定）', () => {
    const { ir } = buildFixture();
    const canvas = ir.canvases[0]!;
    ir.nodes.push(
      createPageNode({ name: '关于', codeName: 'About', canvasId: canvas.id, page: { route: '/about', title: '关于', layout: 'blank', components: [] } }),
    );
    const { pages } = emitUiSchema(ir);
    expect(pages.map((p) => p.route)).toEqual(['/about', '/devices']);
  });
});

describe('组件转换', () => {
  it('searchForm 保留字段与绑定的接口', () => {
    const { ir } = buildFixture();
    const page = firstPage(ir);
    const form = page.components.find((c) => c.type === 'searchForm');
    expect(form).toBeDefined();
    if (form?.type !== 'searchForm') throw new Error('类型收窄失败');
    expect(form.inline).toBe(true);
    expect(form.fields.map((f) => f.prop)).toEqual(['deviceName', 'status']);
    expect(form.api?.operationId).toBe('listDevices');
  });

  it('table 的列保留宽度、枚举映射与分页模式', () => {
    const { ir } = buildFixture();
    const page = firstPage(ir);
    const table = page.components.find((c) => c.type === 'table');
    if (table?.type !== 'table') throw new Error('类型收窄失败');
    expect(table.columns.map((c) => c.prop)).toEqual(['deviceId', 'deviceName', 'status']);
    expect(table.columns[0]?.width).toBe(160);
    expect(table.columns[2]?.enumMap).toEqual({ ACTIVE: '在线', OFFLINE: '离线', DISABLED: '停用' });
    expect(table.pagination.mode).toBe('server');
  });

  it('字段标签优先用 binding.label，其次字段注释，最后字段名', () => {
    const { ir } = buildFixture();
    const page = firstPage(ir);
    const form = page.components.find((c) => c.type === 'searchForm');
    if (form?.type !== 'searchForm') throw new Error('类型收窄失败');
    // fixture 未设置 binding.label，回退到字段注释
    expect(form.fields[0]?.label).toBe('设备名称');
  });

  it('binding.label 覆盖字段注释', () => {
    const { ir, listPage } = buildFixture();
    const form = listPage.page.components.find((c) => c.type === 'searchForm');
    if (form === undefined) throw new Error('找不到 searchForm');
    form.bindings[0]!.label = '名称搜索';
    const page = firstPage(ir);
    const out = page.components.find((c) => c.type === 'searchForm');
    if (out?.type !== 'searchForm') throw new Error('类型收窄失败');
    expect(out.fields[0]?.label).toBe('名称搜索');
  });

  it('控件类型由字段类型推导', () => {
    const ir = createEmptyIR({ projectName: 'P' });
    const canvas = ir.canvases[0]!;
    const table = createTableNode({
      name: '表',
      codeName: 'Thing',
      canvasId: canvas.id,
      table: {
        dbName: 'things',
        fields: [
          createField({ name: 'a', type: 'text' }),
          createField({ name: 'b', type: 'integer' }),
          createField({ name: 'c', type: 'boolean' }),
          createField({ name: 'd', type: 'date' }),
          createField({ name: 'e', type: 'datetime' }),
          createField({ name: 'f', type: 'file' }),
          createField({ name: 'g', type: 'string' }),
        ],
        indexes: [],
        softDelete: false,
        timestamps: false,
      },
    });
    const api = createApiNode({
      name: '接口',
      codeName: 'listThings',
      canvasId: canvas.id,
      api: {
        method: 'GET',
        path: '/things',
        summary: 's',
        tags: [],
        auth: 'none',
        pathParams: [],
        query: [],
        headers: [],
        responses: [{ status: 200, description: 'ok', shape: 'array', fields: table.table.fields }],
      },
    });
    const page = createPageNode({
      name: '页',
      codeName: 'ThingList',
      canvasId: canvas.id,
      page: { route: '/things', title: '列表', layout: 'list', components: [createForm(api.id, table.table.fields.map((f) => ({ fieldRef: f.id })))] },
    });
    ir.nodes.push(table, api, page);

    const { pages } = emitUiSchema(ir);
    const form = pages[0]!.components[0];
    if (form?.type !== 'form') throw new Error('类型收窄失败');
    expect(form.fields.map((f) => f.control)).toEqual(['textarea', 'number', 'switch', 'date', 'datetime', 'upload', 'input']);
  });

  it('显式 binding.control 覆盖推导结果', () => {
    const { ir, listPage } = buildFixture();
    const form = listPage.page.components.find((c) => c.type === 'searchForm');
    if (form === undefined) throw new Error('找不到 searchForm');
    form.bindings[0]!.control = 'cascader';
    const page = firstPage(ir);
    const out = page.components.find((c) => c.type === 'searchForm');
    if (out?.type !== 'searchForm') throw new Error('类型收窄失败');
    expect(out.fields[0]?.control).toBe('cascader');
  });

  it('action 组件导出为 actionGroup，带跳转与确认文案', () => {
    const ir = createEmptyIR({ projectName: 'P' });
    const canvas = ir.canvases[0]!;
    const page = createPageNode({
      name: '页',
      codeName: 'Home',
      canvasId: canvas.id,
      page: {
        route: '/',
        title: '首页',
        layout: 'blank',
        components: [
          {
            id: 'cp_AAAAAAAAAAAA',
            type: 'action',
            title: '新建',
            bindings: [],
            trigger: { event: 'click' },
            navigateTo: '/devices/new',
            confirm: { text: '确定新建？' },
            level: 'primary',
          },
        ],
      },
    });
    ir.nodes.push(page);

    const { pages } = emitUiSchema(ir);
    const group = pages[0]!.components[0];
    if (group?.type !== 'action') throw new Error('类型收窄失败');
    expect(group.actions[0]).toMatchObject({
      label: '新建',
      level: 'primary',
      navigateTo: '/devices/new',
      confirm: '确定新建？',
    });
  });
});

describe('数据源', () => {
  it('收集页面用到的接口并去重', () => {
    const { ir } = buildFixture();
    const page = firstPage(ir);
    expect(page.dataSources.map((d) => d.operationId)).toEqual(['listDevices']);
  });

  it('记录每个数据源被消费的响应字段（用于裁剪类型与 mock）', () => {
    const { ir } = buildFixture();
    const page = firstPage(ir);
    const ds = page.dataSources.find((d) => d.operationId === 'listDevices');
    expect(ds?.responseFields.map((f) => f.prop).sort()).toEqual(['deviceId', 'deviceName', 'status']);
    // 类型必须一起带出来：只给 prop 的话生成器只能写 unknown，
    // 而 unknown 绑到 Element Plus 控件上是一片 TS2322（在生成出来的项目里才报）
    expect(ds?.responseFields.find((f) => f.prop === 'deviceId')?.tsType).toBe('string');
  });

  it('dataSources 带 apiNodeId 供反查', () => {
    const { ir, listApi } = buildFixture();
    const page = firstPage(ir);
    expect(page.dataSources[0]?.apiNodeId).toBe(listApi.id);
  });

  it('mount 事件连线被识别为 mountApi', () => {
    const { ir } = buildFixture();
    const page = firstPage(ir);
    expect(page.mountApi?.operationId).toBe('listDevices');
  });

  it('没有 mount 连线时不产出 mountApi', () => {
    const { ir, edges } = buildFixture();
    ir.edges = edges.filter((e) => e.trigger?.event !== 'mount');
    expect(firstPage(ir).mountApi).toBeUndefined();
  });

  it('引用不存在的接口节点时给 warning 而不崩溃', () => {
    const { ir, listPage } = buildFixture();
    const form = listPage.page.components.find((c) => c.type === 'searchForm');
    if (form === undefined) throw new Error('找不到 searchForm');
    form.apiRef = 'nd_MISSING00000';
    const { warnings } = emitUiSchema(ir);
    expect(warnings.some((w) => w.includes('nd_MISSING00000'))).toBe(true);
  });
});

describe('字段解析', () => {
  it('enum 字段解析出 enumValues 与枚举类型名', () => {
    const { ir } = buildFixture();
    const page = firstPage(ir);
    const form = page.components.find((c) => c.type === 'searchForm');
    if (form?.type !== 'searchForm') throw new Error('类型收窄失败');
    const status = form.fields.find((f) => f.prop === 'status');
    expect(status?.enumValues).toEqual(['ACTIVE', 'OFFLINE', 'DISABLED']);
    expect(status?.tsType).toBe('DeviceStatus');
  });

  it('required 字段生成 required 规则', () => {
    const { ir } = buildFixture();
    const page = firstPage(ir);
    const form = page.components.find((c) => c.type === 'searchForm');
    if (form?.type !== 'searchForm') throw new Error('类型收窄失败');
    expect(form.fields[0]?.rules).toEqual([
      { kind: 'required', message: '设备名称不能为空', trigger: 'blur' },
    ]);
  });

  it('minLength / maxLength 转成 min / max 规则', () => {
    const ir = createEmptyIR({ projectName: 'P' });
    const canvas = ir.canvases[0]!;
    const field = createField({ name: 'code', type: 'string', constraints: { minLength: 2, maxLength: 8 } });
    const table = createTableNode({
      name: '表',
      codeName: 'Thing',
      canvasId: canvas.id,
      table: { dbName: 'things', fields: [field], indexes: [], softDelete: false, timestamps: false },
    });
    const api = createApiNode({
      name: '接口',
      codeName: 'createThing',
      canvasId: canvas.id,
      api: { method: 'POST', path: '/things', summary: 's', tags: [], auth: 'none', pathParams: [], query: [], headers: [], responses: [{ status: 201, description: 'ok', shape: 'object', fields: [field] }] },
    });
    const page = createPageNode({
      name: '页',
      codeName: 'ThingNew',
      canvasId: canvas.id,
      page: { route: '/things/new', title: '新建', layout: 'form', components: [createForm(api.id, [{ fieldRef: field.id }])] },
    });
    ir.nodes.push(table, api, page);

    const { pages } = emitUiSchema(ir);
    const form = pages[0]!.components[0];
    if (form?.type !== 'form') throw new Error('类型收窄失败');
    expect(form.fields[0]?.rules.map((r) => r.kind)).toEqual(['required', 'min', 'max']);
  });

  it('binding.rules 追加在字段约束之后且去重', () => {
    const { ir, listPage } = buildFixture();
    const form = listPage.page.components.find((c) => c.type === 'searchForm');
    if (form === undefined) throw new Error('找不到 searchForm');
    form.bindings[0]!.rules = [
      { type: 'required', message: '设备名称不能为空', trigger: 'blur' },
      { type: 'pattern', value: '^[a-z]+$', message: '只能小写字母' },
    ];
    const page = firstPage(ir);
    const out = page.components.find((c) => c.type === 'searchForm');
    if (out?.type !== 'searchForm') throw new Error('类型收窄失败');
    const kinds = out.fields[0]!.rules.map((r) => r.kind);
    expect(kinds).toEqual(['required', 'pattern']);
  });

  it('绑定了不存在的字段时给 warning 并跳过', () => {
    const { ir, listPage } = buildFixture();
    const form = listPage.page.components.find((c) => c.type === 'searchForm');
    if (form === undefined) throw new Error('找不到 searchForm');
    form.bindings.push({ fieldRef: 'fd_MISSING00000' });
    const { pages, warnings } = emitUiSchema(ir);
    expect(warnings.some((w) => w.includes('fd_MISSING00000'))).toBe(true);
    const out = pages[0]!.components.find((c) => c.type === 'searchForm');
    if (out?.type !== 'searchForm') throw new Error('类型收窄失败');
    expect(out.fields.map((f) => f.prop)).toEqual(['deviceName', 'status']);
  });
});

describe('TS 类型推导', () => {
  it('各字段类型映射到 TS 类型', () => {
    const ir = createEmptyIR({ projectName: 'P' });
    const canvas = ir.canvases[0]!;
    const fields = [
      createField({ name: 'a', type: 'string' }),
      createField({ name: 'b', type: 'integer' }),
      createField({ name: 'c', type: 'boolean' }),
      createField({ name: 'd', type: 'json' }),
    ];
    const table = createTableNode({
      name: '表',
      codeName: 'Thing',
      canvasId: canvas.id,
      table: { dbName: 'things', fields, indexes: [], softDelete: false, timestamps: false },
    });
    const api = createApiNode({
      name: '接口',
      codeName: 'getThing',
      canvasId: canvas.id,
      api: { method: 'GET', path: '/things', summary: 's', tags: [], auth: 'none', pathParams: [], query: [], headers: [], responses: [{ status: 200, description: 'ok', shape: 'object', fields }] },
    });
    const page = createPageNode({
      name: '页',
      codeName: 'ThingDetail',
      canvasId: canvas.id,
      page: { route: '/things/1', title: '详情', layout: 'detail', components: [createForm(api.id, fields.map((f) => ({ fieldRef: f.id })))] },
    });
    ir.nodes.push(table, api, page);

    const { pages } = emitUiSchema(ir);
    const form = pages[0]!.components[0];
    if (form?.type !== 'form') throw new Error('类型收窄失败');
    expect(form.fields.map((f) => f.tsType)).toEqual(['string', 'number', 'boolean', 'unknown']);
  });

  it('数组字段的 tsType 带元素类型', () => {
    const ir = createEmptyIR({ projectName: 'P' });
    const canvas = ir.canvases[0]!;
    const field = createField({ name: 'tags', type: 'array', constraints: { arrayItem: 'string' } });
    const table = createTableNode({
      name: '表',
      codeName: 'Thing',
      canvasId: canvas.id,
      table: { dbName: 'things', fields: [field], indexes: [], softDelete: false, timestamps: false },
    });
    const api = createApiNode({
      name: '接口',
      codeName: 'getThing',
      canvasId: canvas.id,
      api: { method: 'GET', path: '/things', summary: 's', tags: [], auth: 'none', pathParams: [], query: [], headers: [], responses: [{ status: 200, description: 'ok', shape: 'object', fields: [field] }] },
    });
    const page = createPageNode({
      name: '页',
      codeName: 'T',
      canvasId: canvas.id,
      page: { route: '/t', title: 'T', layout: 'detail', components: [createForm(api.id, [{ fieldRef: field.id }])] },
    });
    ir.nodes.push(table, api, page);

    const { pages } = emitUiSchema(ir);
    const form = pages[0]!.components[0];
    if (form?.type !== 'form') throw new Error('类型收窄失败');
    expect(form.fields[0]?.tsType).toBe('string[]');
  });
});

describe('确定性', () => {
  it('同一 IR 两次编译结果一致', () => {
    const { ir } = buildFixture();
    expect(JSON.stringify(emitUiSchema(ir))).toBe(JSON.stringify(emitUiSchema(ir)));
  });

  it('不泄漏 IR 内部节点 ID 到组件引用里', () => {
    const { ir } = buildFixture();
    const json = JSON.stringify(emitUiSchema(ir).pages);
    expect(json).not.toContain('nodeId');
  });
});
