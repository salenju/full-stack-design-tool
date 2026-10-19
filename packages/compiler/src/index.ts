/**
 * @fsdt/compiler 公共入口：IR → 各种产物。
 */

export { emitOpenApi, suggestPathForTable } from './openapi/emit-openapi.js';
export { serializeOpenApi } from './openapi/serialize.js';
export type { SerializeOptions } from './openapi/serialize.js';
export type { EmitOpenApiOptions, EmitOpenApiResult } from './openapi/emit-openapi.js';

export { fieldToSchema, fieldsToObjectSchema, allocateSchemaName } from './openapi/field-schema.js';
export type { FieldToSchemaOptions, NameRegistry } from './openapi/field-schema.js';

export { isRef, schemaRef } from './openapi/types.js';
export type {
  InfoObject,
  MediaTypeObject,
  OpenApiDocument,
  OperationObject,
  ParameterObject,
  PathItemObject,
  ReferenceObject,
  RequestBodyObject,
  ResponseObject,
  SchemaObject,
  SchemaObjectType,
  SchemaOrRef,
  SecuritySchemeObject,
  TagObject,
} from './openapi/types.js';

// ── UI Schema ────────────────────────────────────────────────────────
export { emitUiSchema, fieldOwnerTable, toRouterPath, collectPageProps } from './ui-schema/emit-ui-schema.js';
export type {
  ActionGroupSchema,
  ActionSchema,
  CardSchema,
  ColumnSchema,
  ComponentBaseSchema,
  ComponentSchema,
  DataFieldSchema,
  DataSourceSchema,
  EnumTypeSchema,
  DetailSchema,
  EmitUiSchemaOptions,
  FieldSchema,
  FormRule,
  FormSchema,
  PageSchema,
  SearchFormSchema,
  TableSchema,
  TabsSchema,
  UiSchemaResult,
} from './ui-schema/emit-ui-schema.js';

// ── 公共 ─────────────────────────────────────────────────────────────
export { allocateOperationIds } from './common/operation-ids.js';
export type { OperationIdAllocation } from './common/operation-ids.js';
