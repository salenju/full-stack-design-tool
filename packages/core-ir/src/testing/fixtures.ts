/**
 * 测试用 IR 构造器。
 *
 * 不用固定 JSON 文件当 fixture，理由：IR 是「活的结构」，加字段时手工维护的 JSON
 * 会大面积失效；用构造器 + 少量显式覆盖，schema 变更时只需修一处。
 */

import {
  createApiNode,
  createEmptyIR,
  createField,
  createPageNode,
  createTable,
  createTableNode,
  createSearchForm,
  newNodeId,
  newEdgeId,
  newEnumId,
  type ApiNode,
  type Canvas,
  type EnumDef,
  type Field,
  type IR,
  type IREdge,
  type PageNode,
  type TableNode,
} from '../index.js';

export interface FixtureResult {
  ir: IR;
  canvas: Canvas;
  deviceTable: TableNode;
  deviceIdField: Field;
  deviceNameField: Field;
  statusField: Field;
  listApi: ApiNode;
  createApi: ApiNode;
  listPage: PageNode;
  edges: IREdge[];
}

/** 构造一个「设备管理」场景的最小可用 IR：一张表、两个接口、一个页面、三条连线 */
export function buildFixture(): FixtureResult {
  const ir = createEmptyIR({ projectName: '设备管理', projectId: 'prj_fixture' });
  const canvas = ir.canvases[0];
  if (canvas === undefined) throw new Error('fixture 需要至少一块画布');

  // ── 枚举 ──
  const statusEnum: EnumDef = {
    id: newEnumId(),
    name: 'DeviceStatus',
    description: '设备状态',
    values: [
      { value: 'ACTIVE', label: '在线' },
      { value: 'OFFLINE', label: '离线' },
      { value: 'DISABLED', label: '停用' },
    ],
  };
  ir.dictionaries.enums.push(statusEnum);

  // ── 表 ──
  const deviceIdField = createField({ name: 'deviceId', type: 'string', comment: '设备编号' });
  const deviceNameField = createField({ name: 'deviceName', type: 'string', comment: '设备名称' });
  const statusField = createField({
    name: 'status',
    type: 'enum',
    comment: '状态',
    constraints: { enumRef: statusEnum.id },
  });
  const createdAtField = createField({ name: 'createdAt', type: 'datetime', comment: '创建时间' });

  const deviceTable = createTableNode({
    name: '设备',
    codeName: 'Device',
    canvasId: canvas.id,
    table: {
      dbName: 'devices',
      comment: '设备主表',
      fields: [deviceIdField, deviceNameField, statusField, createdAtField],
      indexes: [{ id: 'ix_FIXTUREPK001', fieldIds: [deviceIdField.id], unique: true }],
      softDelete: false,
      timestamps: true,
    },
  });

  // ── 接口 ──
  const listApi = createApiNode({
    name: '查询设备列表',
    codeName: 'listDevices',
    canvasId: canvas.id,
    api: {
      method: 'GET',
      path: '/devices',
      summary: '分页查询设备',
      tags: ['设备'],
      auth: 'none',
      pathParams: [],
      query: [
        createField({ name: 'page', type: 'integer', required: false }),
        createField({ name: 'pageSize', type: 'integer', required: false }),
      ],
      headers: [],
      responses: [
        {
          status: 200,
          description: '成功',
          shape: 'array',
          fields: [
            createField({ name: 'deviceId', type: 'string' }),
            createField({ name: 'deviceName', type: 'string' }),
            createField({ name: 'status', type: 'enum', constraints: { enumRef: statusEnum.id } }),
            createField({ name: 'createdAt', type: 'datetime' }),
          ],
          envelope: { dataKey: 'items', totalKey: 'total' },
        },
      ],
    },
  });

  const createApi = createApiNode({
    name: '创建设备',
    codeName: 'createDevice',
    canvasId: canvas.id,
    api: {
      method: 'POST',
      path: '/devices',
      summary: '创建设备',
      tags: ['设备'],
      auth: 'none',
      pathParams: [],
      query: [],
      headers: [],
      requestBody: {
        shape: 'object',
        required: true,
        fields: [
          createField({ name: 'deviceName', type: 'string', constraints: { minLength: 1, maxLength: 64 } }),
          createField({ name: 'status', type: 'enum', constraints: { enumRef: statusEnum.id } }),
        ],
      },
      responses: [
        {
          status: 201,
          description: '创建成功',
          shape: 'object',
          fields: [
            createField({ name: 'deviceId', type: 'string' }),
            createField({ name: 'deviceName', type: 'string' }),
          ],
        },
      ],
    },
  });

  // ── 页面 ──
  const searchForm = createSearchForm(listApi.id, [
    { fieldRef: deviceNameField.id },
    { fieldRef: statusField.id, control: 'select' },
  ]);
  const tableComponent = createTable(
    listApi.id,
    [
      { fieldRef: deviceIdField.id, width: 160 },
      { fieldRef: deviceNameField.id },
      { fieldRef: statusField.id },
    ],
    { rowKeyFieldRef: deviceIdField.id },
  );

  const listPage = createPageNode({
    name: '设备列表页',
    codeName: 'DeviceList',
    canvasId: canvas.id,
    page: {
      route: '/devices',
      title: '设备列表',
      layout: 'list',
      components: [searchForm, tableComponent],
    },
  });

  // ── 连线 ──
  const edges: IREdge[] = [
    {
      id: newEdgeId(),
      kind: 'call',
      canvasId: canvas.id,
      source: { nodeId: listPage.id },
      target: { nodeId: listApi.id },
      trigger: { event: 'mount' },
    },
    {
      id: newEdgeId(),
      kind: 'read',
      canvasId: canvas.id,
      source: { nodeId: listApi.id },
      target: { nodeId: deviceTable.id },
    },
    {
      id: newEdgeId(),
      kind: 'write',
      canvasId: canvas.id,
      source: { nodeId: createApi.id },
      target: { nodeId: deviceTable.id },
    },
  ];

  ir.nodes.push(deviceTable, listApi, createApi, listPage);
  ir.edges.push(...edges);

  return {
    ir,
    canvas,
    deviceTable,
    deviceIdField,
    deviceNameField,
    statusField,
    listApi,
    createApi,
    listPage,
    edges,
  };
}

/** 深拷贝 fixture，便于每个用例独立改动 */
export function cloneIR(ir: IR): IR {
  return JSON.parse(JSON.stringify(ir)) as IR;
}

/** 只改设置的 IR 副本（测试生成选项影响时可复现） */
export function withSettings(ir: IR, patch: Partial<IR['settings']>): IR {
  const copy = cloneIR(ir);
  copy.settings = { ...copy.settings, ...patch };
  return copy;
}

/** 生成一个未挂载到 IR 的孤立节点 ID，用于测试 dangling 引用 */
export function danglingNodeId(): string {
  return newNodeId();
}
