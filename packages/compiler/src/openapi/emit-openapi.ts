/**
 * IR → OpenAPI 3.1 文档。
 *
 * 设计要点（对应技术设计 6.2）：
 *
 * 1. **表 → 命名 schema。** `TableNode` 产出四个 schema：实体、Create、Update、Page（分页包装）。
 *    只有表会产出命名 schema，接口的请求/响应体一律内联。理由：表的 schema 会被多个接口复用
 *    且会被前端/types 导入，值得有名字；请求响应体是「某个接口专用的形状」，给它命名会导致
 *    `ListDevicesResponse2` 这类无人想维护的名字。
 *
 * 2. **Create 与 Update 不是「同结构少几个字段」，而是显式的字段集合。** Create 排除
 *    主键与只读/时间戳字段；Update 在此基础上把所有字段变可选。这两件事用 exclude +
 *    改 required 数组表达，而不是靠生成器猜。
 *
 * 3. **确定性输出。** 所有 Record 的键按字典序插入，数组按固定规则排序。同一 IR 两次编译
 *    必须字节级一致——否则 `fsdt gen --check` 的漂移检测会每次误报。
 *
 * 4. **不写 example 到字段以外的位置。** 只有字段显式声明了 example 才写（见 field-schema.ts）。
 */

import {
  buildGraphIndex,
  pluralize,
  toCamelCase,
  toKebabCase,
  toPascalCase,
  type EnumDef,
  type Field,
  type IR,
  type TableNode,
} from '@fsdt/core-ir';

import { allocateOperationIds } from '../common/operation-ids.js';
import {
  allocateSchemaName,
  fieldToSchema,
  fieldsToObjectSchema,
  type FieldToSchemaOptions,
  type NameRegistry,
} from './field-schema.js';
import {
  schemaRef,
  type MediaTypeObject,
  type OpenApiDocument,
  type OperationObject,
  type ParameterObject,
  type PathItemObject,
  type ResponseObject,
  type SchemaObject,
  type SchemaOrRef,
  type SecuritySchemeObject,
} from './types.js';

export interface EmitOpenApiOptions {
  /** API 文档标题，默认用 IR 的项目名 */
  title?: string;
  /** 文档版本，默认用 IR 的 meta.generator 去掉前缀 */
  version?: string;
  /** 服务地址列表；缺省写 http://localhost:3000 便于直接试跑 */
  servers?: string[];
  /** 是否把 `x-dsg-*` 扩展写入（默认 true；关闭用于给不认扩展的第三方工具） */
  extensions?: boolean;
}

export interface EmitOpenApiResult {
  document: OpenApiDocument;
  /** 编译期提示（非阻断）：命名冲突、字段类型退化等 */
  warnings: string[];
  /** operationId → 接口节点 ID，供代码生成器与 Lint 反查 */
  operationIndex: Record<string, string>;
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
type HttpMethodKey = (typeof HTTP_METHODS)[number];

const METHOD_KEY: Record<string, HttpMethodKey> = {
  GET: 'get',
  POST: 'post',
  PUT: 'put',
  PATCH: 'patch',
  DELETE: 'delete',
};

/** 按字典序插入键，保证输出稳定 */
function sortedRecord<T>(entries: Array<[string, T]>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [key, value] of [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    out[key] = value;
  }
  return out;
}

/** 主键字段：优先 name === 'id' 且 required；否则取单列 unique 索引 */
function primaryKeyOf(table: TableNode): Field | undefined {
  const byName = table.table.fields.find((f) => f.name === 'id' && f.required);
  if (byName !== undefined) return byName;
  const uniqueIndex = table.table.indexes.find((i) => i.unique && i.fieldIds.length === 1);
  if (uniqueIndex !== undefined) {
    const id = uniqueIndex.fieldIds[0];
    return table.table.fields.find((f) => f.id === id);
  }
  return undefined;
}

/** 管理型字段：创建请求里不该出现 */
function isManagedField(field: Field): boolean {
  return field.readOnly === true || field.name === 'createdAt' || field.name === 'updatedAt' || field.name === 'deletedAt';
}

export function emitOpenApi(ir: IR, options: EmitOpenApiOptions = {}): EmitOpenApiResult {
  const warnings: string[] = [];
  const g = buildGraphIndex(ir);

  const enumByName = new Map<string, EnumDef>();
  for (const def of ir.dictionaries.enums) enumByName.set(def.id, def);

  // ── 表 → schema 名 ──────────────────────────────────────────────
  const registry: NameRegistry = new Map();
  const tableNameById = new Map<string, string>();
  for (const table of [...g.tables.values()].sort((a, b) => (a.table.dbName < b.table.dbName ? -1 : 1))) {
    // 表名优先用 codeName（已是 PascalCase），退化用 dbName
    const base = table.codeName.length > 0 ? table.codeName : toPascalCase(table.table.dbName);
    const name = allocateSchemaName(base, registry);
    tableNameById.set(table.id, name);
  }

  const fieldOptions: FieldToSchemaOptions = {
    tableSchemaName: (tableId) => tableNameById.get(tableId),
    enumByName,
  };

  const componentsSchemas: Array<[string, SchemaOrRef]> = [];

  for (const table of [...g.tables.values()]) {
    const name = tableNameById.get(table.id);
    if (name === undefined) continue;
    const pk = primaryKeyOf(table);
    const excludedFromCreate = new Set<string>();
    if (pk !== undefined) excludedFromCreate.add(pk.id);
    for (const f of table.table.fields) {
      if (isManagedField(f)) excludedFromCreate.add(f.id);
    }

    // 实体：全部字段，required 按字段声明
    componentsSchemas.push([
      name,
      withTableMeta(
        fieldsToObjectSchema(table.table.fields, { ...fieldOptions, side: 'entity' }),
        table,
        options.extensions !== false,
      ),
    ]);

    // Create：排除主键与管理字段
    componentsSchemas.push([
      `${name}Create`,
      fieldsToObjectSchema(table.table.fields, {
        ...fieldOptions,
        side: 'request',
        exclude: excludedFromCreate,
      }),
    ]);

    // Update：同 Create 的字段集合，但全部可选
    const updateSchema = fieldsToObjectSchema(table.table.fields, {
      ...fieldOptions,
      side: 'request',
      exclude: excludedFromCreate,
    });
    delete updateSchema.required;
    componentsSchemas.push([`${name}Update`, updateSchema]);

    // Page：分页包装。字段与实体一致，便于前端把列表行直接当实体用。
    const pageSchema: SchemaObject = {
      type: 'object',
      properties: {
        items: { type: 'array', items: schemaRef(name) },
        total: { type: 'integer', minimum: 0 },
        page: { type: 'integer', minimum: 1 },
        pageSize: { type: 'integer', minimum: 1 },
      },
      required: ['items', 'total'],
    };
    componentsSchemas.push([`${name}Page`, pageSchema]);
  }

  // ── 接口 ──────────────────────────────────────────────────────
  const pathEntries = new Map<string, PathItemObject>();
  const operationIndex: Record<string, string> = {};
  const securitySchemes: Record<string, SecuritySchemeObject> = {};
  const allocation = allocateOperationIds(ir);
  warnings.push(...allocation.warnings);

  const apis = [...g.apis.values()].sort((a, b) => {
    if (a.api.path !== b.api.path) return a.api.path < b.api.path ? -1 : 1;
    return a.api.method < b.api.method ? -1 : 1;
  });

  for (const api of apis) {
    const operationId = allocation.byNodeId.get(api.id) ?? toCamelCase(api.codeName) ?? 'operation';
    const methodKey = METHOD_KEY[api.api.method];
    if (methodKey === undefined) {
      warnings.push(`接口 ${api.id} 的 HTTP 方法「${api.api.method}」无法映射到 OpenAPI，已跳过`);
      continue;
    }

    const parameters: ParameterObject[] = [];
    for (const f of api.api.pathParams) {
      parameters.push(parameterOf(f, 'path', true, fieldOptions));
    }
    for (const f of api.api.query) {
      parameters.push(parameterOf(f, 'query', f.required, fieldOptions));
    }
    for (const f of api.api.headers) {
      parameters.push(parameterOf(f, 'header', f.required, fieldOptions));
    }

    const responses: Record<string, ResponseObject> = {};
    for (const r of api.api.responses) {
      responses[String(r.status)] = responseOf(r, fieldOptions);
    }
    if (Object.keys(responses).length === 0) {
      // schema 已保证至少一条响应，这里只是防御
      responses['200'] = { description: '成功' };
    }

    const operation: OperationObject = {
      operationId,
      summary: api.api.summary.length > 0 ? api.api.summary : api.name,
      responses: sortedRecord(Object.entries(responses)),
    };
    if (api.api.description !== undefined && api.api.description.length > 0) {
      operation.description = api.api.description;
    }
    if (api.api.tags.length > 0) {
      operation.tags = [...api.api.tags].sort();
    }
    if (api.api.deprecated === true) {
      operation.deprecated = true;
    }
    if (parameters.length > 0) {
      operation.parameters = parameters;
    }

    if (api.api.requestBody !== undefined) {
      const body = requestBodyOf(api.api.requestBody, fieldOptions);
      if (body !== undefined) operation.requestBody = body;
    }

    const security = securityOf(api.api.auth, securitySchemes);
    if (security !== undefined) operation.security = security;

    operationIndex[operationId] = api.id;

    const existing = pathEntries.get(api.api.path) ?? {};
    if (existing[methodKey] !== undefined) {
      warnings.push(
        `接口路径重复：${api.api.method} ${api.api.path} 已被 ${existing[methodKey]?.operationId} 占用，` +
          `本次跳过 ${operationId}（Lint IR008 应当已报错）`,
      );
      continue;
    }
    existing[methodKey] = operation;
    pathEntries.set(api.api.path, existing);
  }

  const tags = sortedTags(ir);

  const document: OpenApiDocument = {
    openapi: '3.1.0',
    info: {
      title: options.title ?? ir.project.name,
      version: options.version ?? '0.1.0',
      ...(ir.project.description !== undefined && ir.project.description.length > 0
        ? { description: ir.project.description }
        : {}),
    },
    ...(options.servers !== undefined && options.servers.length > 0
      ? { servers: options.servers.map((url) => ({ url })) }
      : { servers: [{ url: 'http://localhost:3000', description: '本地开发' }] }),
    ...(tags.length > 0 ? { tags } : {}),
    paths: sortedRecord([...pathEntries.entries()]),
    components: {
      schemas: sortedRecord(componentsSchemas),
      ...(Object.keys(securitySchemes).length > 0
        ? { securitySchemes: sortedRecord(Object.entries(securitySchemes)) }
        : {}),
    },
  };

  return { document, warnings, operationIndex };
}

function withTableMeta(schema: SchemaObject, table: TableNode, extensions: boolean): SchemaObject {
  const out: SchemaObject = { ...schema };
  if (table.table.comment !== undefined && out.description === undefined) {
    out.description = table.table.comment;
  }
  if (extensions) {
    out['x-dsg-table'] = table.table.dbName;
    out['x-dsg-node'] = table.id;
  }
  return out;
}

function parameterOf(field: Field, location: ParameterObject['in'], required: boolean, options: FieldToSchemaOptions): ParameterObject {
  const param: ParameterObject = {
    name: field.name,
    in: location,
    required,
    schema: fieldToSchema(field, { ...options, side: 'request' }),
  };
  const description = field.description ?? field.comment;
  if (description !== undefined && description.length > 0) param.description = description;
  if (field.example !== undefined) param.example = field.example;
  if (field.deprecated === true) param.deprecated = true;
  return param;
}

function responseOf(
  r: { status: number; description: string; fields: Field[]; shape: string; envelope?: { dataKey: string; totalKey?: string } },
  options: FieldToSchemaOptions,
): ResponseObject {
  const description = r.description.length > 0 ? r.description : '响应';

  if (r.shape === 'empty' || r.fields.length === 0) {
    return { description };
  }

  if (r.shape === 'raw') {
    return {
      description,
      content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
    };
  }

  const itemSchema = fieldsToObjectSchema(r.fields, { ...options, side: 'response' });
  let bodySchema: SchemaObject;

  if (r.envelope !== undefined) {
    // 信封：{ [dataKey]: items[], [totalKey]: integer }
    const props: Record<string, SchemaOrRef> =
      r.shape === 'array'
        ? { [r.envelope.dataKey]: { type: 'array', items: itemSchema } }
        : { [r.envelope.dataKey]: itemSchema };
    if (r.envelope.totalKey !== undefined) {
      props[r.envelope.totalKey] = { type: 'integer', minimum: 0 };
    }
    bodySchema = { type: 'object', properties: props, required: [r.envelope.dataKey] };
  } else if (r.shape === 'array') {
    bodySchema = { type: 'array', items: itemSchema };
  } else {
    bodySchema = itemSchema;
  }

  const media: MediaTypeObject = { schema: bodySchema };
  return { description, content: { 'application/json': media } };
}

function requestBodyOf(
  body: { shape: string; fields: Field[]; contentType?: string; required: boolean },
  options: FieldToSchemaOptions,
): { description?: string; required: boolean; content: Record<string, MediaTypeObject> } | undefined {
  const contentType = body.contentType ?? 'application/json';

  if (body.shape === 'raw') {
    return {
      required: body.required,
      content: { [contentType]: { schema: { type: 'string', format: 'binary' } } },
    };
  }

  const itemSchema: SchemaObject = fieldsToObjectSchema(body.fields, { ...options, side: 'request' });
  const schema: SchemaObject = body.shape === 'array' ? { type: 'array', items: itemSchema } : itemSchema;

  return {
    required: body.required,
    content: { [contentType]: { schema } },
  };
}

function securityOf(
  auth: 'none' | 'bearer' | 'apikey',
  schemes: Record<string, SecuritySchemeObject>,
): Array<Record<string, string[]>> | undefined {
  if (auth === 'none') return undefined;
  if (auth === 'bearer') {
    schemes['bearerAuth'] ??= { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' };
    return [{ bearerAuth: [] }];
  }
  schemes['apiKeyAuth'] ??= { type: 'apiKey', in: 'header', name: 'X-API-Key' };
  return [{ apiKeyAuth: [] }];
}

function sortedTags(ir: IR): Array<{ name: string }> {
  const names = new Set<string>();
  for (const api of buildGraphIndex(ir).apis.values()) {
    for (const tag of api.api.tags) names.add(tag);
  }
  return [...names].sort().map((name) => ({ name }));
}

/** 从表名推导 REST 路径片段（导出给接口命名建议用） */
export function suggestPathForTable(table: TableNode): string {
  return `/${toKebabCase(pluralize(table.table.dbName))}`;
}
