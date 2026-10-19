/**
 * IR → OpenAPI 3.1 内部数据结构。
 *
 * 为什么自己定义一套类型而不是直接装 `openapi-types`：
 * 1. 我们只需要 OpenAPI 3.1 的一个子集，完整包的类型有 200+ 个可选字段，会把所有
 *    赋值处都变成「可能 undefined」的噪声；
 * 2. 自己写意味着**每个我们主动产出的字段都是一次显式决定**，而不是「反正类型允许」；
 * 3. 少数必要处（`$ref` / `oneOf`）显式建模，避免误用。
 *
 * 输出前会用 `@apidevtools/swagger-parser` 做一次真实校验（见 emit-openapi.test.ts），
 * 所以自写类型不会带来「自己说合法就合法」的风险。
 */

export type SchemaObjectType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null';

/** JSON Schema 2020-12 的子集（OpenAPI 3.1 用的是这个方言） */
export interface SchemaObject {
  type?: SchemaObjectType | SchemaObjectType[];
  format?: string;
  title?: string;
  description?: string;
  default?: unknown;
  example?: unknown;
  enum?: unknown[];
  const?: unknown;
  nullable?: boolean;
  /** 只读 / 只写：OpenAPI 3.1 从 JSON Schema 校验关键字提升而来 */
  readOnly?: boolean;
  writeOnly?: boolean;
  deprecated?: boolean;
  /** 数值 */
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
  /** 字符串 */
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  /** 数组 */
  items?: SchemaObject | ReferenceObject;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  /** 对象 */
  properties?: Record<string, SchemaObject | ReferenceObject>;
  required?: string[];
  additionalProperties?: boolean | SchemaObject | ReferenceObject;
  /** 组合 */
  oneOf?: Array<SchemaObject | ReferenceObject>;
  anyOf?: Array<SchemaObject | ReferenceObject>;
  allOf?: Array<SchemaObject | ReferenceObject>;
  /** 扩展字段（x-dsg-*） */
  [extension: `x-dsg-${string}`]: unknown;
}

export interface ReferenceObject {
  $ref: string;
  description?: string;
  /** 3.1 允许 $ref 旁注，用于在列表里给同名引用加标识 */
  summary?: string;
}

export type SchemaOrRef = SchemaObject | ReferenceObject;

export interface ParameterObject {
  name: string;
  in: 'path' | 'query' | 'header';
  description?: string;
  required: boolean;
  deprecated?: boolean;
  schema: SchemaOrRef;
  example?: unknown;
}

export interface MediaTypeObject {
  schema: SchemaOrRef;
  example?: unknown;
  examples?: Record<string, { value: unknown; summary?: string }>;
}

export interface RequestBodyObject {
  description?: string;
  required: boolean;
  content: Record<string, MediaTypeObject>;
}

export interface ResponseObject {
  description: string;
  headers?: Record<string, { description?: string; schema: SchemaOrRef }>;
  content?: Record<string, MediaTypeObject>;
}

export interface OperationObject {
  operationId: string;
  summary: string;
  description?: string;
  tags?: string[];
  deprecated?: boolean;
  parameters?: ParameterObject[];
  requestBody?: RequestBodyObject;
  responses: Record<string, ResponseObject>;
  security?: Array<Record<string, string[]>>;
}

export interface PathItemObject {
  summary?: string;
  description?: string;
  get?: OperationObject;
  post?: OperationObject;
  put?: OperationObject;
  patch?: OperationObject;
  delete?: OperationObject;
}

export interface SecuritySchemeObject {
  type: 'http' | 'apiKey' | 'oauth2' | 'openIdConnect';
  scheme?: string;
  bearerFormat?: string;
  name?: string;
  in?: 'header' | 'query' | 'cookie';
  description?: string;
}

export interface InfoObject {
  title: string;
  version: string;
  description?: string;
  contact?: { name?: string; url?: string; email?: string };
  license?: { name: string; url?: string };
}

export interface TagObject {
  name: string;
  description?: string;
}

export interface OpenApiDocument {
  openapi: '3.1.0';
  info: InfoObject;
  servers?: Array<{ url: string; description?: string }>;
  tags?: TagObject[];
  paths: Record<string, PathItemObject>;
  components: {
    schemas: Record<string, SchemaOrRef>;
    securitySchemes?: Record<string, SecuritySchemeObject>;
  };
}

export function isRef(value: SchemaOrRef): value is ReferenceObject {
  return typeof value === 'object' && value !== null && '$ref' in value && typeof (value as ReferenceObject).$ref === 'string';
}

/** 构造一个指向 components.schemas 的 $ref */
export function schemaRef(name: string): ReferenceObject {
  return { $ref: `#/components/schemas/${name}` };
}
