/**
 * FSDT 中间表示（IR）：全工具的唯一真相源。
 *
 * 设计约束（见技术设计 1.1）：
 * 1. IR 是唯一真相源；OpenAPI / UI Schema / 示例数据 / 代码 / AI 上下文都是 f(IR, Options) 的产物。
 * 2. 节点与边用「扁平数组 + ID」存储，而不是嵌套树——diff、三方合并、增量编译都以「按 ID 定位」为前提。
 * 3. Field 是一等实体，拥有永不复用的 ID；页面组件通过 fieldRef 引用它，而不是复制字段名。
 */

// ────────────────────────────── 基础标量 ──────────────────────────────

export type NodeKind = 'table' | 'api' | 'page' | 'note';

export type EdgeKind = 'call' | 'read' | 'write' | 'map' | 'navigate';

export type FieldType =
  | 'string'
  | 'text'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'enum'
  | 'object'
  | 'array'
  | 'ref'
  | 'file'
  | 'json';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type AuthMode = 'none' | 'bearer' | 'apikey';

export type PageLayout = 'list' | 'form' | 'detail' | 'dashboard' | 'blank';

// ────────────────────────────── 字段 ──────────────────────────────

export interface FieldConstraints {
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  /** 正则表达式源码（不带斜杠） */
  pattern?: string;
  /** 指向 dictionaries.enums[].id */
  enumRef?: string;
  /** 内联枚举，枚举值即字面量 */
  enumValues?: string[];
  default?: unknown;
  precision?: number;
  scale?: number;
  /** type === 'array' 时的元素类型 */
  arrayItem?: FieldType;
  /** type === 'ref' 时的外键目标 */
  ref?: ForeignKeyRef;
}

export interface ForeignKeyRef {
  tableId: string;
  /** 缺省时指向目标表的主键 */
  fieldId?: string;
  onDelete?: 'restrict' | 'cascade' | 'setNull';
}

export interface Field {
  /** 'fd_' + nanoid(12)，永不复用 */
  id: string;
  /** camelCase（API / 前端） */
  name: string;
  /** snake_case（表）；表节点内必填 */
  dbName?: string;
  type: FieldType;
  /** 中文名 / 说明，用于生成注释与语义化造数 */
  comment?: string;
  description?: string;
  required: boolean;
  nullable: boolean;
  readOnly?: boolean;
  writeOnly?: boolean;
  /** 造数掩码 + AI 上下文脱敏 */
  sensitive?: boolean;
  deprecated?: boolean;
  constraints?: FieldConstraints;
  /** 显式示例，优先级高于自动生成 */
  example?: unknown;
  /** 锁定示例值：重新造数时不变 */
  locked?: boolean;
  /** 画布表现：是否显示端口，以及端口顺序 */
  port?: { visible: boolean; order: number };
}

// ────────────────────────────── 节点公共部分 ──────────────────────────────

export interface NodeBase {
  /** 'nd_' + nanoid(12) */
  id: string;
  kind: NodeKind;
  /** 显示名 */
  name: string;
  /** 代码标识（表=模型名，接口=operationId，页面=组件名） */
  codeName: string;
  canvasId: string;
  position: { x: number; y: number };
  size: { w: number; h: number };
  /** 折叠后只显示前 5 个字段 */
  collapsed: boolean;
  color?: string;
  tags: string[];
  notes?: string;
  locked?: boolean;
}

// ────────────────────────────── 表节点 ──────────────────────────────

export interface IndexDef {
  id: string;
  /** 索引名，缺省按规则生成 */
  name?: string;
  /** 参与索引的字段 ID */
  fieldIds: string[];
  unique: boolean;
}

export interface TableDef {
  /** snake_case 物理表名 */
  dbName: string;
  comment?: string;
  fields: Field[];
  /** 主键 / 唯一约束通过 Field 的 required+constraints 与 indexes 表达 */
  indexes: IndexDef[];
  /** 是否生成 deletedAt */
  softDelete: boolean;
  /** 是否生成 createdAt / updatedAt */
  timestamps: boolean;
}

export interface TableNode extends NodeBase {
  kind: 'table';
  table: TableDef;
}

// ────────────────────────────── 接口节点 ──────────────────────────────

export interface BodyDef {
  /** 请求体形状；object 对应 JSON body，其余为原始 body */
  shape: 'object' | 'array' | 'raw';
  fields: Field[];
  /** Content-Type，默认 application/json */
  contentType?: string;
  required: boolean;
}

export interface ResponseDef {
  /** HTTP 状态码 */
  status: number;
  description: string;
  /** 响应体形状；204 等无 body 时留空数组 */
  fields: Field[];
  shape: 'object' | 'array' | 'raw' | 'empty';
  /** 是否把 fields 包在 { data, total } 之类的信封里 */
  envelope?: { dataKey: string; totalKey?: string };
}

export interface ApiDef {
  method: HttpMethod;
  /** '/devices/{id}'，参数用花括号 */
  path: string;
  summary: string;
  description?: string;
  tags: string[];
  auth: AuthMode;
  deprecated?: boolean;
  pathParams: Field[];
  query: Field[];
  headers: Field[];
  requestBody?: BodyDef;
  /** 至少一条 */
  responses: ResponseDef[];
}

export interface ApiNode extends NodeBase {
  kind: 'api';
  api: ApiDef;
}

// ────────────────────────────── 页面节点 ──────────────────────────────

export interface ValidationRule {
  /** element-plus 的 rule 类型语义 */
  type?: 'required' | 'min' | 'max' | 'len' | 'pattern' | 'email' | 'url' | 'custom';
  value?: unknown;
  message: string;
  trigger?: 'blur' | 'change';
}

export interface FieldBinding {
  /** 指向 Field.id（不复制字段名） */
  fieldRef: string;
  /** 覆盖显示名 */
  label?: string;
  control?:
    | 'input'
    | 'textarea'
    | 'number'
    | 'select'
    | 'radio'
    | 'checkbox'
    | 'switch'
    | 'date'
    | 'datetime'
    | 'upload'
    | 'cascader'
    | 'slot';
  /** 栅格宽度 1-24 */
  span?: number;
  placeholder?: string;
  /** 额外校验，与字段约束合并 */
  rules?: ValidationRule[];
}

export interface ComponentBase {
  /** 'cp_' + nanoid(12) */
  id: string;
  type: string;
  title?: string;
  /** 受限表达式，如 'status === "ACTIVE"' */
  visibleWhen?: string;
  bindings: FieldBinding[];
}

export interface SearchFormComponent extends ComponentBase {
  type: 'searchForm';
  inline: boolean;
  collapsible: boolean;
  /** 提交后调用的接口节点 ID */
  apiRef: string;
}

export interface TableColumn {
  fieldRef: string;
  width?: number;
  align?: 'left' | 'center' | 'right';
  sortable?: boolean;
  ellipsis?: boolean;
  /** 受限表达式模板，如 "row.status === 1 ? '启用' : '禁用'" */
  formatter?: string;
}

export interface TableComponent extends ComponentBase {
  type: 'table';
  /** 数据源接口 */
  apiRef: string;
  rowKeyFieldRef?: string;
  pagination: { mode: 'server' | 'client'; pageSize: number };
  columns: TableColumn[];
  rowActions: ActionComponent[];
  selection: 'none' | 'single' | 'multiple';
}

export interface FormComponent extends ComponentBase {
  type: 'form';
  mode: 'create' | 'edit';
  /** 提交接口 */
  apiRef: string;
  /** 编辑时回显接口 */
  loadApiRef?: string;
  layout: 'horizontal' | 'vertical';
  submitText: string;
}

export interface DetailComponent extends ComponentBase {
  type: 'detail';
  apiRef: string;
  columns: 1 | 2 | 3;
}

export interface ActionComponent extends ComponentBase {
  type: 'action';
  trigger: { event: 'click' | 'submit'; componentId?: string };
  apiRef?: string;
  /** 页面路由 */
  navigateTo?: string;
  confirm?: { text: string };
  level?: 'primary' | 'default' | 'danger';
}

export interface TabsComponent extends ComponentBase {
  type: 'tabs';
  tabs: Array<{ key: string; label: string; componentIds: string[] }>;
  activeKey?: string;
}

export interface CardComponent extends ComponentBase {
  type: 'card';
  componentIds: string[];
  shadow: 'always' | 'hover' | 'never';
}

export type PageComponent =
  | SearchFormComponent
  | TableComponent
  | FormComponent
  | DetailComponent
  | ActionComponent
  | TabsComponent
  | CardComponent;

export interface PageDef {
  /** '/devices' */
  route: string;
  title: string;
  layout: PageLayout;
  components: PageComponent[];
}

export interface PageNode extends NodeBase {
  kind: 'page';
  page: PageDef;
}

// ────────────────────────────── 备注节点 ──────────────────────────────

export interface NoteDef {
  text: string;
  groupId?: string;
}

export interface NoteNode extends NodeBase {
  kind: 'note';
  note: NoteDef;
}

export type IRNode = TableNode | ApiNode | PageNode | NoteNode;

// ────────────────────────────── 连线 ──────────────────────────────

export interface EdgeEndpoint {
  nodeId: string;
  /** 字段级端口时必填 */
  fieldId?: string;
  /** 端口方向，与 Field.port 配合 */
  port?: 'in' | 'out';
}

export type TransformFn =
  | 'identity'
  | 'trim'
  | 'toNumber'
  | 'toString'
  | 'dateFormat'
  | 'lookup'
  | 'custom';

export interface EdgeTransform {
  fn: TransformFn;
  args?: unknown[];
  /** fn === 'custom' 时的受限表达式（白名单函数，无副作用） */
  expression?: string;
}

export interface CallTrigger {
  /**
   * 触发组件。`mount` 事件没有发起组件（页面一挂载就调用），此时省略；
   * `click` / `submit` / `change` 由某个组件发起，Lint 会要求它必须存在且属于该页面。
   */
  componentId?: string;
  event: 'click' | 'submit' | 'mount' | 'change';
}

export interface NavigateInfo {
  params?: Record<string, string>;
  query?: Record<string, string>;
}

export interface IREdge {
  /** 'ed_' + nanoid(12) */
  id: string;
  kind: EdgeKind;
  source: EdgeEndpoint;
  target: EdgeEndpoint;
  label?: string;
  /** 仅 map 使用 */
  transform?: EdgeTransform;
  /** 仅 call 使用：页面动作触发 */
  trigger?: CallTrigger;
  /** 仅 navigate 使用 */
  nav?: NavigateInfo;
  canvasId: string;
}

// ────────────────────────────── 项目级可复用资产 ──────────────────────────────

export interface EnumValue {
  value: string;
  label?: string;
  /** 造数权重，默认 1 */
  weight?: number;
  color?: string;
}

export interface EnumDef {
  id: string;
  /** 代码中的枚举名（PascalCase） */
  name: string;
  description?: string;
  values: EnumValue[];
}

export interface ModelDef {
  id: string;
  /** 代码中的类型名（PascalCase），如 'PageResult' */
  name: string;
  description?: string;
  fields: Field[];
}

// ────────────────────────────── 设置 ──────────────────────────────

export interface FrontendSettings {
  framework: 'vue';
  /** 已确认：P0 只实现 element-plus，其余仅作扩展位 */
  ui: 'element-plus' | 'naive-ui' | 'ant-design-vue';
  /** 已确认：固定 script-setup，保留 'options' 仅为读取旧 IR 的向前兼容 */
  apiStyle: 'script-setup' | 'options';
  packageManager: 'pnpm' | 'npm' | 'yarn';
  stateSolution: 'pinia';
  requestLib: 'axios' | 'ofetch';
  strictness: 'strict';
}

export interface BackendSettings {
  framework: 'nestjs';
  /** P1 只实现 prisma；typeorm 走 CodeGenerator 适配器 */
  orm: 'prisma' | 'typeorm';
  validation: 'class-validator';
  swagger: boolean;
  /** 已确认：P0 固定 'none'，只生成契约层 security 描述 + 挂载点 */
  auth: 'none' | 'jwt';
}

export interface NamingSettings {
  tableCase: 'snake' | 'camel';
  fieldCase: 'camel' | 'snake';
  pathCase: 'kebab' | 'snake';
  fileCase: 'kebab' | 'pascal';
}

export interface GenerationSettings {
  outDir: string;
  sampleCount: number;
  /** 项目级固定种子，保证造数确定性 */
  sampleSeed: number;
  aiEnabled: boolean;
  aiProvider?: 'openai' | 'anthropic' | 'openai-compatible';
  aiModel?: string;
}

export interface ImportSettings {
  /** 默认 0.85 */
  candidateAutoAcceptThreshold: number;
  /** 默认 0.5 */
  candidateManualThreshold: number;
  visionProvider?: 'openai-vision' | 'custom';
}

export interface ExportSettings {
  image: 'png' | 'svg';
  structure: 'json' | 'mermaid' | 'drawio' | 'figma';
  /** 导出图是否标注字段级端口，默认 false（避免拥挤） */
  includeFieldPorts: boolean;
}

export interface LintIgnore {
  ruleId: string;
  targetId: string;
  reason: string;
}

export interface LintSettings {
  enabled: boolean;
  blockOnError: boolean;
  ruleOverrides: Record<string, 'off' | 'info' | 'warn' | 'error'>;
  ignores: LintIgnore[];
}

export interface ProjectSettings {
  frontend: FrontendSettings;
  backend: BackendSettings;
  naming: NamingSettings;
  generation: GenerationSettings;
  import: ImportSettings;
  export: ExportSettings;
  lint: LintSettings;
}

// ────────────────────────────── 画布与素材 ──────────────────────────────

export interface CanvasBackground {
  /** 指向 assets/ 下的图片 */
  assetId: string;
  /** 0–1，默认 0.25 */
  opacity: number;
  /** 锁定时不响应点击，避免挡住节点 */
  locked: boolean;
  fit: 'contain' | 'width';
  offset: { x: number; y: number };
  scale: number;
}

export interface Canvas {
  id: string;
  name: string;
  order: number;
  viewport: { x: number; y: number; zoom: number };
  background?: CanvasBackground;
  grid: { enabled: boolean; size: number };
}

export type AssetSource =
  | { channel: 'figma'; fileKey: string; nodeId: string; fileVersion: string }
  | { channel: 'upload'; filename: string };

export interface Asset {
  id: string;
  kind: 'design' | 'screenshot' | 'figma-export';
  /** 相对 assets/ */
  path: string;
  width: number;
  height: number;
  bytes: number;
  sha256: string;
  source?: AssetSource;
  createdAt: string;
}

// ────────────────────────────── 顶层 ──────────────────────────────

export interface ProjectMeta {
  id: string;
  name: string;
  description?: string;
  /** 生成产物的包名前缀，如 '@acme' */
  packageScope?: string;
}

export interface IRMeta {
  createdAt: string;
  updatedAt: string;
  /** 生成此 IR 的工具版本 */
  generator: string;
}

export interface IR {
  /** IR 结构版本，随不兼容变更递增 */
  schemaVersion: 1;
  project: ProjectMeta;
  canvases: Canvas[];
  /** 扁平存储，便于 diff 与索引 */
  nodes: IRNode[];
  edges: IREdge[];
  /** 项目级可复用资产 */
  dictionaries: {
    enums: EnumDef[];
    models: ModelDef[];
  };
  assets: Asset[];
  settings: ProjectSettings;
  meta: IRMeta;
}

// ────────────────────────────── 联合类型守卫 ──────────────────────────────

export function isTableNode(node: IRNode): node is TableNode {
  return node.kind === 'table';
}

export function isApiNode(node: IRNode): node is ApiNode {
  return node.kind === 'api';
}

export function isPageNode(node: IRNode): node is PageNode {
  return node.kind === 'page';
}

export function isNoteNode(node: IRNode): node is NoteNode {
  return node.kind === 'note';
}
