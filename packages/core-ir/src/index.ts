/**
 * @fsdt/core-ir 公共入口。
 *
 * 只做显式再导出（不用 `export *`），原因：
 * - `types.ts` 与 `schema.ts` 有同名导出（如 `fieldSchema` 与 `Field`），通配导出会在
 *   后续新增名字时静默冲突，报错点还不在改动处；
 * - 显式清单本身是「本包对外承诺的 API 面」，改动即破坏性变更，review 时一眼可见。
 */

// ── 类型 ──────────────────────────────────────────────────────────────
export type {
  NodeKind,
  EdgeKind,
  FieldType,
  HttpMethod,
  AuthMode,
  PageLayout,
  FieldConstraints,
  ForeignKeyRef,
  Field,
  NodeBase,
  IndexDef,
  TableDef,
  TableNode,
  BodyDef,
  ResponseDef,
  ApiDef,
  ApiNode,
  ValidationRule,
  FieldBinding,
  ComponentBase,
  SearchFormComponent,
  TableColumn,
  TableComponent,
  FormComponent,
  DetailComponent,
  ActionComponent,
  TabsComponent,
  CardComponent,
  PageComponent,
  PageDef,
  PageNode,
  NoteDef,
  NoteNode,
  IRNode,
  EdgeEndpoint,
  TransformFn,
  EdgeTransform,
  CallTrigger,
  NavigateInfo,
  IREdge,
  EnumValue,
  EnumDef,
  ModelDef,
  FrontendSettings,
  BackendSettings,
  NamingSettings,
  GenerationSettings,
  ImportSettings,
  ExportSettings,
  LintIgnore,
  LintSettings,
  ProjectSettings,
  CanvasBackground,
  Canvas,
  AssetSource,
  Asset,
  ProjectMeta,
  IRMeta,
  IR,
} from './types.js';

export { isTableNode, isApiNode, isPageNode, isNoteNode } from './types.js';

// ── 常量与默认值 ──────────────────────────────────────────────────────
export {
  IR_SCHEMA_VERSION,
  GENERATOR_ID,
  defaultConstraintsFor,
  createField,
  createTableNode,
  createApiNode,
  createPageNode,
  createNoteNode,
  createBinding,
  createSearchForm,
  createTable,
  createForm,
  createAction,
  createCanvas,
  createAsset,
  defaultSettings,
  createEmptyIR,
  COMPONENT_TYPES,
  isComponentType,
  cloneComponents,
} from './defaults.js';

export type { CreateFieldInput, CreateIRInput, ComponentType } from './defaults.js';

// ── ID ───────────────────────────────────────────────────────────────
export {
  ID_PREFIX,
  newId,
  newNodeId,
  newFieldId,
  newEdgeId,
  newComponentId,
  newCanvasId,
  newAssetId,
  newEnumId,
  newModelId,
  newIndexId,
  isIdKind,
  isValidId,
} from './ids.js';

export type { IdKind } from './ids.js';

// ── 校验 ─────────────────────────────────────────────────────────────
export {
  irSchema,
  irNodeSchema,
  pageComponentSchema,
  irEdgeSchema,
  projectSettingsSchema,
  canvasSchema,
  assetSchema,
  fieldSchema,
  nodeIdSchema,
  fieldIdSchema,
  edgeIdSchema,
  enumIdSchema,
  modelIdSchema,
} from './schema.js';

export type { IRSchemaInput, IRSchemaOutput } from './schema.js';

export { validateIR, assertValidIR, buildIndex, getEdgeIdsOf } from './validate.js';
export { IRValidationError, isDiagnostic } from './diagnostics.js';
export type { Severity, DiagnosticTarget, Diagnostic } from './diagnostics.js';

// ── 迁移与读写 ────────────────────────────────────────────────────────
export {
  MIGRATIONS,
  CURRENT_SCHEMA_VERSION,
  UnsupportedSchemaVersionError,
  migrateToCurrent,
  migrateIR,
} from './migrations.js';

export type { UnknownIR, MigrationStep } from './migrations.js';

export { IRFileError, parseIR, coerceToIR, loadIR, saveIR, serializeIR, pathExists } from './io.js';
export type { LoadIROptions, LoadIRResult, SaveIROptions } from './io.js';

// ── 哈希与规范化 ──────────────────────────────────────────────────────
export { canonicalize, stableStringify } from './canonical.js';
export type { CanonicalOptions } from './canonical.js';

export { semanticView, computeSchemaHash, bareHash, hashContent, hashRegion } from './hash.js';
export type { HashSubjectOptions } from './hash.js';

// ── 图索引与命名 ──────────────────────────────────────────────────────
export {
  buildGraphIndex,
  getNode,
  getTable,
  getApi,
  getPage,
  getField,
  getFieldOwner,
  nodeFieldIdsOf,
  sortedTables,
  sortedApis,
  sortedPages,
  sortedEnums,
  outgoingEdges,
  incomingEdges,
  reachableFromPage,
} from './graph.js';

export type { GraphIndex, FieldLocation, ComponentLocation, ReachableSubgraph } from './graph.js';

export {
  splitWords,
  toCamelCase,
  toPackageName,
  toPascalCase,
  toSnakeCase,
  toKebabCase,
  toConstantCase,
  pluralize,
  singularize,
  tableToPathSegment,
  tableToModelName,
  pathToOperationId,
  fieldToDbName,
  fieldToApiName,
  toFileName,
  isIdentifier,
  RESERVED_WORDS,
  safeIdentifier,
} from './naming.js';
