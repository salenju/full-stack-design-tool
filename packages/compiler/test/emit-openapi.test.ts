import { buildFixture } from '@fsdt/core-ir/testing';
import { createApiNode, createEmptyIR, createField, createPageNode, createTableNode } from '@fsdt/core-ir';
import SwaggerParser from '@apidevtools/swagger-parser';
import { describe, expect, it } from 'vitest';

import { emitOpenApi } from '../src/index.js';
import { isRef } from '../src/openapi/types.js';
import type { OpenApiDocument, SchemaObject, SchemaOrRef, OperationObject } from '../src/openapi/types.js';

async function validate(doc: OpenApiDocument): Promise<void> {
  // swagger-parser 的 validate 会解析 $ref、检查 paths 与 components 的一致性。
  // 传深拷贝，避免它内部修改我们的文档（历史上它会给缺失项补默认值）。
  await SwaggerParser.validate(structuredClone(doc) as never);
}

function schemaOf(doc: OpenApiDocument, name: string): SchemaObject {
  const found = doc.components.schemas[name];
  expect(found, `期望存在 schema「${name}」，实际有：${Object.keys(doc.components.schemas).join(', ')}`).toBeDefined();
  expect(isRef(found as SchemaOrRef)).toBe(false);
  return found as SchemaObject;
}

function operation(doc: OpenApiDocument, path: string, method: string): OperationObject {
  const item = doc.paths[path];
  expect(item, `期望存在路径 ${path}`).toBeDefined();
  const op = (item as Record<string, unknown>)[method] as OperationObject | undefined;
  expect(op, `期望 ${method.toUpperCase()} ${path} 存在`).toBeDefined();
  return op as OperationObject;
}

describe('文档骨架', () => {
  it('产出合法 OpenAPI 3.1 文档（经 swagger-parser 校验）', async () => {
    const { ir } = buildFixture();
    const { document } = emitOpenApi(ir);
    expect(document.openapi).toBe('3.1.0');
    await validate(document);
  });

  it('info 取项目名，版本可覆盖', () => {
    const { ir } = buildFixture();
    const a = emitOpenApi(ir).document;
    expect(a.info.title).toBe('设备管理');
    const b = emitOpenApi(ir, { title: '设备服务', version: '1.2.3' }).document;
    expect(b.info.title).toBe('设备服务');
    expect(b.info.version).toBe('1.2.3');
  });

  it('缺省 servers 指向本地服务', () => {
    const { ir } = buildFixture();
    const { document } = emitOpenApi(ir);
    expect(document.servers?.[0]?.url).toBe('http://localhost:3000');
  });

  it('同一 IR 两次编译字节级一致（确定性）', () => {
    const { ir } = buildFixture();
    const a = JSON.stringify(emitOpenApi(ir).document);
    const b = JSON.stringify(emitOpenApi(ir).document);
    expect(a).toBe(b);
  });

  it('重新创建等价 IR（新随机 ID）仍产出同样结构', () => {
    const a = emitOpenApi(buildFixture().ir, { title: 'X' }).document;
    const b = emitOpenApi(buildFixture().ir, { title: 'X' }).document;
    // ID 不同但 schema 名、路径、operationId 应完全一致
    expect(Object.keys(a.components.schemas).sort()).toEqual(Object.keys(b.components.schemas).sort());
    expect(Object.keys(a.paths).sort()).toEqual(Object.keys(b.paths).sort());
  });
});

describe('表 → 命名 schema', () => {
  it('每张表产出实体 / Create / Update / Page 四个 schema', () => {
    const { ir } = buildFixture();
    const { document } = emitOpenApi(ir);
    for (const suffix of ['', 'Create', 'Update', 'Page']) {
      expect(document.components.schemas[`Device${suffix}`]).toBeDefined();
    }
  });

  it('实体 schema 的属性名取字段 name（camelCase）', () => {
    const { ir } = buildFixture();
    const { document } = emitOpenApi(ir);
    const device = schemaOf(document, 'Device');
    expect(Object.keys(device.properties ?? {})).toEqual(['deviceId', 'deviceName', 'status', 'createdAt']);
  });

  it('required 收集在父对象上，而不是写在字段里', () => {
    const { ir } = buildFixture();
    const { document } = emitOpenApi(ir);
    const device = schemaOf(document, 'Device');
    // createField 默认 required: true
    expect(device.required).toEqual(['deviceId', 'deviceName', 'status', 'createdAt']);
    for (const prop of Object.values(device.properties ?? {})) {
      expect((prop as SchemaObject).required).toBeUndefined();
      expect((prop as SchemaObject).nullable).toBeUndefined();
    }
  });

  it('Create 排除了主键与 createdAt', () => {
    const { ir } = buildFixture();
    const { document } = emitOpenApi(ir);
    const create = schemaOf(document, 'DeviceCreate');
    expect(Object.keys(create.properties ?? {})).toEqual(['deviceName', 'status']);
  });

  it('Update 与 Create 字段集合相同但全部可选', () => {
    const { ir } = buildFixture();
    const { document } = emitOpenApi(ir);
    const create = schemaOf(document, 'DeviceCreate');
    const update = schemaOf(document, 'DeviceUpdate');
    expect(Object.keys(update.properties ?? {})).toEqual(Object.keys(create.properties ?? {}));
    expect(update.required).toBeUndefined();
  });

  it('Page schema 是 items + total 的分页包装，items 用 $ref 复用实体', () => {
    const { ir } = buildFixture();
    const { document } = emitOpenApi(ir);
    const page = schemaOf(document, 'DevicePage');
    const items = page.properties?.items as SchemaObject;
    expect(items.type).toBe('array');
    expect(items.items).toEqual({ $ref: '#/components/schemas/Device' });
    expect(page.properties?.total).toBeDefined();
    expect(page.required).toEqual(['items', 'total']);
  });

  it('实体带 x-dsg-table 扩展，默认写表名', () => {
    const { ir } = buildFixture();
    const { document } = emitOpenApi(ir);
    const device = schemaOf(document, 'Device');
    expect(device['x-dsg-table']).toBe('devices');
  });

  it('extensions: false 时不写 x-dsg 扩展', () => {
    const { ir } = buildFixture();
    const { document } = emitOpenApi(ir, { extensions: false });
    const device = schemaOf(document, 'Device');
    expect(device['x-dsg-table']).toBeUndefined();
    expect(Object.keys(device).some((k) => k.startsWith('x-dsg-'))).toBe(false);
  });

  it('表注释写进 schema description', () => {
    const { ir } = buildFixture();
    const { document } = emitOpenApi(ir);
    expect(schemaOf(document, 'Device').description).toBe('设备主表');
  });
});

describe('字段 → JSON Schema', () => {
  it('datetime 映射为 string + format: date-time', () => {
    const { ir } = buildFixture();
    const { document } = emitOpenApi(ir);
    const device = schemaOf(document, 'Device');
    expect(device.properties?.createdAt).toMatchObject({ type: 'string', format: 'date-time' });
  });

  it('enum 展开为 enum[] 字面量（不是 $ref）', () => {
    const { ir } = buildFixture();
    const { document } = emitOpenApi(ir);
    const device = schemaOf(document, 'Device');
    expect(device.properties?.status).toMatchObject({
      type: 'string',
      enum: ['ACTIVE', 'OFFLINE', 'DISABLED'],
    });
  });

  it('字段注释写进 description', () => {
    const { ir } = buildFixture();
    const { document } = emitOpenApi(ir);
    const device = schemaOf(document, 'Device');
    expect((device.properties?.deviceName as SchemaObject).description).toBe('设备名称');
  });

  it('constraints 映射到校验关键字', () => {
    const { ir } = buildFixture();
    const { document } = emitOpenApi(ir);
    // 约束声明在 POST /devices 的请求体字段上（不是表字段），所以从 operation 里取
    const body = operation(document, '/devices', 'post').requestBody?.content['application/json']?.schema as SchemaObject;
    expect(body.properties?.deviceName).toMatchObject({ minLength: 1, maxLength: 64 });
  });

  it('sensitive 字段带 x-dsg-sensitive', () => {
    const { ir, deviceTable } = buildFixture();
    const nameField = deviceTable.table.fields.find((f) => f.name === 'deviceName');
    expect(nameField).toBeDefined();
    nameField!.sensitive = true;
    const { document } = emitOpenApi(ir);
    expect((schemaOf(document, 'Device').properties?.deviceName as SchemaObject)['x-dsg-sensitive']).toBe(true);
  });

  it('readOnly 字段在请求侧被标记 readOnly（生成器据此过滤）', () => {
    const { ir, deviceTable } = buildFixture();
    const idField = deviceTable.table.fields.find((f) => f.name === 'deviceId');
    idField!.readOnly = true;
    const { document } = emitOpenApi(ir);
    const device = schemaOf(document, 'Device');
    expect((device.properties?.deviceId as SchemaObject).readOnly).toBe(true);
  });

  it('未声明 example 的字段不凭空产生 example', () => {
    const { ir } = buildFixture();
    const { document } = emitOpenApi(ir);
    const device = schemaOf(document, 'Device');
    for (const prop of Object.values(device.properties ?? {})) {
      expect((prop as SchemaObject).example).toBeUndefined();
    }
  });

  it('显式 example 被写入', () => {
    const { ir, deviceTable } = buildFixture();
    const nameField = deviceTable.table.fields.find((f) => f.name === 'deviceName');
    nameField!.example = '一号机';
    const { document } = emitOpenApi(ir);
    expect((schemaOf(document, 'Device').properties?.deviceName as SchemaObject).example).toBe('一号机');
  });

  it('ref 字段退化为 string 并标注外键目标字段', () => {
    const ir = createEmptyIR({ projectName: 'P' });
    const canvas = ir.canvases[0]!;
    const idField = createField({ name: 'id', type: 'string' });
    const parent = createTableNode({
      name: '父表',
      codeName: 'Parent',
      canvasId: canvas.id,
      table: { dbName: 'parents', fields: [idField], indexes: [], softDelete: false, timestamps: false },
    });
    const fkField = createField({
      name: 'parentId',
      type: 'ref',
      constraints: { ref: { tableId: parent.id, fieldId: idField.id } },
    });
    const child = createTableNode({
      name: '子表',
      codeName: 'Child',
      canvasId: canvas.id,
      table: { dbName: 'children', fields: [fkField], indexes: [], softDelete: false, timestamps: false },
    });
    ir.nodes.push(parent, child);

    const { document } = emitOpenApi(ir);
    const childSchema = schemaOf(document, 'Child');
    expect(childSchema.properties?.parentId).toMatchObject({ type: 'string', 'x-dsg-fk-field': idField.id });
  });

  it('ref 指向不存在的表时退化为 string 而不是崩溃', () => {
    const ir = createEmptyIR({ projectName: 'P' });
    const canvas = ir.canvases[0]!;
    const fkField = createField({
      name: 'ghostId',
      type: 'ref',
      constraints: { ref: { tableId: 'nd_GHOST000000' } },
    });
    const node = createTableNode({
      name: '表',
      codeName: 'Thing',
      canvasId: canvas.id,
      table: { dbName: 'things', fields: [fkField], indexes: [], softDelete: false, timestamps: false },
    });
    ir.nodes.push(node);

    const { document } = emitOpenApi(ir);
    expect(schemaOf(document, 'Thing').properties?.ghostId).toMatchObject({ type: 'string' });
  });

  it('array 字段产出 items', () => {
    const ir = createEmptyIR({ projectName: 'P' });
    const canvas = ir.canvases[0]!;
    const tags = createField({ name: 'tags', type: 'array', constraints: { arrayItem: 'string' } });
    const node = createTableNode({
      name: '表',
      codeName: 'Post',
      canvasId: canvas.id,
      table: { dbName: 'posts', fields: [tags], indexes: [], softDelete: false, timestamps: false },
    });
    ir.nodes.push(node);

    const { document } = emitOpenApi(ir);
    expect(schemaOf(document, 'Post').properties?.tags).toMatchObject({
      type: 'array',
      items: { type: 'string' },
    });
  });

  it('json 字段产出无类型约束的空 schema', () => {
    const ir = createEmptyIR({ projectName: 'P' });
    const canvas = ir.canvases[0]!;
    const blob = createField({ name: 'blob', type: 'json' });
    const node = createTableNode({
      name: '表',
      codeName: 'Blob',
      canvasId: canvas.id,
      table: { dbName: 'blobs', fields: [blob], indexes: [], softDelete: false, timestamps: false },
    });
    ir.nodes.push(node);

    const { document } = emitOpenApi(ir);
    const schema = schemaOf(document, 'Blob').properties?.blob as SchemaObject;
    expect(schema.type).toBeUndefined();
  });
});

describe('接口 → paths', () => {
  it('所有接口都出现在 paths 里', () => {
    const { ir } = buildFixture();
    const { document } = emitOpenApi(ir);
    expect(Object.keys(document.paths).sort()).toEqual(['/devices']);
    expect(operation(document, '/devices', 'get').operationId).toBe('listDevices');
    expect(operation(document, '/devices', 'post').operationId).toBe('createDevice');
  });

  it('query 参数带 required 与类型', () => {
    const { ir } = buildFixture();
    const { document } = emitOpenApi(ir);
    const list = operation(document, '/devices', 'get');
    const page = list.parameters?.find((p) => p.name === 'page');
    expect(page).toMatchObject({ in: 'query', required: false, schema: { type: 'integer' } });
  });

  it('path 参数永远 required: true', () => {
    const ir = createEmptyIR({ projectName: 'P' });
    const canvas = ir.canvases[0]!;
    const idField = createField({ name: 'id', type: 'string', required: false });
    const node = createApiNodeHelper(canvas.id, {
      method: 'GET',
      path: '/devices/{id}',
      pathParams: [idField],
      responses: [{ status: 200, description: 'ok', shape: 'object', fields: [idField] }],
    });
    ir.nodes.push(node);

    const { document } = emitOpenApi(ir);
    const op = operation(document, '/devices/{id}', 'get');
    expect(op.parameters?.[0]).toMatchObject({ name: 'id', in: 'path', required: true });
  });

  it('requestBody 结构正确', () => {
    const { ir } = buildFixture();
    const { document } = emitOpenApi(ir);
    const create = operation(document, '/devices', 'post');
    expect(create.requestBody?.required).toBe(true);
    const media = create.requestBody?.content['application/json'];
    expect(media).toBeDefined();
    expect((media!.schema as SchemaObject).properties).toHaveProperty('deviceName');
  });

  it('带 envelope 的数组响应包成 { items, total }', () => {
    const { ir } = buildFixture();
    const { document } = emitOpenApi(ir);
    const list = operation(document, '/devices', 'get');
    const schema = list.responses['200']?.content?.['application/json']?.schema as SchemaObject;
    expect(schema.type).toBe('object');
    expect(schema.properties).toHaveProperty('items');
    expect(schema.properties).toHaveProperty('total');
    expect((schema.properties!.items as SchemaObject).type).toBe('array');
  });

  it('无 envelope 的数组响应直接是数组', () => {
    const ir = createEmptyIR({ projectName: 'P' });
    const canvas = ir.canvases[0]!;
    const f = createField({ name: 'id', type: 'string' });
    ir.nodes.push(
      createApiNodeHelper(canvas.id, {
        method: 'GET',
        path: '/plain',
        responses: [{ status: 200, description: 'ok', shape: 'array', fields: [f] }],
      }),
    );
    const { document } = emitOpenApi(ir);
    const schema = operation(document, '/plain', 'get').responses['200']?.content?.['application/json']
      ?.schema as SchemaObject;
    expect(schema.type).toBe('array');
  });

  it('204 无 body 响应不产出 content', () => {
    const ir = createEmptyIR({ projectName: 'P' });
    const canvas = ir.canvases[0]!;
    ir.nodes.push(
      createApiNodeHelper(canvas.id, {
        method: 'DELETE',
        path: '/things/{id}',
        pathParams: [createField({ name: 'id', type: 'string' })],
        responses: [{ status: 204, description: '已删除', shape: 'empty', fields: [] }],
      }),
    );
    const { document } = emitOpenApi(ir);
    const resp = operation(document, '/things/{id}', 'delete').responses['204'];
    expect(resp?.content).toBeUndefined();
  });

  it('tags 去重并排序后写到顶层', () => {
    const { ir } = buildFixture();
    const { document } = emitOpenApi(ir);
    expect(document.tags).toEqual([{ name: '设备' }]);
  });

  it('deprecated 接口被标记', () => {
    const { ir, listApi } = buildFixture();
    listApi.api.deprecated = true;
    const { document } = emitOpenApi(ir);
    expect(operation(document, '/devices', 'get').deprecated).toBe(true);
  });

  it('operationId 重复时加后缀并给 warning', () => {
    const { ir, createApi } = buildFixture();
    createApi.codeName = 'listDevices';
    const { document, warnings } = emitOpenApi(ir);
    expect(operation(document, '/devices', 'post').operationId).toBe('listDevices2');
    expect(warnings.some((w) => w.includes('重复'))).toBe(true);
  });
});

describe('鉴权', () => {
  it('auth=none 时不写 security', () => {
    const { ir } = buildFixture();
    const { document } = emitOpenApi(ir);
    expect(operation(document, '/devices', 'get').security).toBeUndefined();
    expect(document.components.securitySchemes).toBeUndefined();
  });

  it('auth=bearer 时写 http bearer scheme 与 operation security', () => {
    const { ir, listApi } = buildFixture();
    listApi.api.auth = 'bearer';
    const { document } = emitOpenApi(ir);
    expect(document.components.securitySchemes?.bearerAuth).toEqual({
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
    });
    expect(operation(document, '/devices', 'get').security).toEqual([{ bearerAuth: [] }]);
  });

  it('auth=apikey 时写 apiKey scheme', () => {
    const { ir, listApi } = buildFixture();
    listApi.api.auth = 'apikey';
    const { document } = emitOpenApi(ir);
    expect(document.components.securitySchemes?.apiKeyAuth).toMatchObject({ type: 'apiKey', in: 'header' });
    expect(operation(document, '/devices', 'get').security).toEqual([{ apiKeyAuth: [] }]);
  });
});

describe('页面不影响契约', () => {
  it('只有页面、没有表和接口时也能产出合法文档', async () => {
    const ir = createEmptyIR({ projectName: '空项目' });
    const canvas = ir.canvases[0]!;
    ir.nodes.push(
      createPageNode({
        name: '首页',
        codeName: 'Home',
        canvasId: canvas.id,
      }),
    );
    const { document } = emitOpenApi(ir);
    await validate(document);
    expect(Object.keys(document.paths)).toEqual([]);
  });

  it('page 组件不进入 OpenAPI（OpenAPI 无页面布局词汇）', () => {
    const { ir } = buildFixture();
    const { document } = emitOpenApi(ir);
    const serialized = JSON.stringify(document);
    expect(serialized).not.toContain('searchForm');
    expect(serialized).not.toContain('pagination');
  });
});

describe('确定性细节', () => {
  it('paths 与 schemas 的键都按字典序（保证 git diff 稳定）', () => {
    const { ir } = buildFixture();
    const { document } = emitOpenApi(ir);
    const schemaKeys = Object.keys(document.components.schemas);
    expect(schemaKeys).toEqual([...schemaKeys].sort());
    const pathKeys = Object.keys(document.paths);
    expect(pathKeys).toEqual([...pathKeys].sort());
  });

  it('operationIndex 把 operationId 映射回节点 ID', () => {
    const { ir, listApi, createApi } = buildFixture();
    const { operationIndex } = emitOpenApi(ir);
    expect(operationIndex['listDevices']).toBe(listApi.id);
    expect(operationIndex['createDevice']).toBe(createApi.id);
  });
});

// ── 小工具 ──────────────────────────────────────────────────────────

function createApiNodeHelper(
  canvasId: string,
  overrides: {
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    path: string;
    pathParams?: ReturnType<typeof createField>[];
    responses: Array<{
      status: number;
      description: string;
      shape: 'object' | 'array' | 'raw' | 'empty';
      fields: ReturnType<typeof createField>[];
    }>;
    query?: ReturnType<typeof createField>[];
  },
) {
  return createApiNode({
    name: 'T',
    codeName: 't',
    canvasId,
    api: {
      method: overrides.method,
      path: overrides.path,
      summary: '测试接口',
      tags: [],
      auth: 'none',
      pathParams: overrides.pathParams ?? [],
      query: overrides.query ?? [],
      headers: [],
      responses: overrides.responses,
    },
  });
}
