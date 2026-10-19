/**
 * IR 的 Zod schema —— 运行时校验的单一事实源。
 *
 * 用法约定：
 * - **内部代码用 types.ts 的类型**（编译期零成本）；
 * - **边界处用这里解析**（读文件、收 HTTP body、导入 Figma 结果、AI 输出）。
 * - 两者靠 `schema-type-parity.test.ts` 断言一致，避免类型与校验漂移。
 *
 * 设计取舍（技术设计 1.2）：不用 zod 反推类型，而是手写 interface + 手写 schema。
 * 原因：schema 需要比接口更「宽容」——例如读取旧 IR 时允许缺省字段走 default；
 * 若由 schema 反推类型，这些 default 会把类型全部变成可选的，污染全部下游代码。
 */

import { z } from 'zod';

import { ID_PREFIX } from './ids.js';

// ────────────────────────────── 原子 ──────────────────────────────

const idSchema = (prefix: string): z.ZodString =>
  z.string().regex(new RegExp(`^${prefix}[A-Za-z0-9_-]{12}$`), `ID 必须是 ${prefix} 加 12 位字符`);

export const nodeIdSchema = idSchema(ID_PREFIX.node);
export const fieldIdSchema = idSchema(ID_PREFIX.field);
export const edgeIdSchema = idSchema(ID_PREFIX.edge);
export const componentIdSchema = idSchema(ID_PREFIX.component);
export const canvasIdSchema = idSchema(ID_PREFIX.canvas);
export const assetIdSchema = idSchema(ID_PREFIX.asset);
export const enumIdSchema = idSchema(ID_PREFIX.enum);
export const modelIdSchema = idSchema(ID_PREFIX.model);
export const indexIdSchema = idSchema(ID_PREFIX.index);

/** IS0-8601 时间戳；用 offset 校验而非 z.iso，避免新旧版本 API 差异 */
const isoDateTime = z.string().refine((v) => !Number.isNaN(Date.parse(v)), '必须是可解析的时间戳');

export const nodeKindSchema = z.enum(['table', 'api', 'page', 'note']);
export const edgeKindSchema = z.enum(['call', 'read', 'write', 'map', 'navigate']);

export const fieldTypeSchema = z.enum([
  'string',
  'text',
  'number',
  'integer',
  'boolean',
  'date',
  'datetime',
  'enum',
  'object',
  'array',
  'ref',
  'file',
  'json',
]);

export const httpMethodSchema = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
export const authModeSchema = z.enum(['none', 'bearer', 'apikey']);
export const pageLayoutSchema = z.enum(['list', 'form', 'detail', 'dashboard', 'blank']);

// ────────────────────────────── 字段 ──────────────────────────────

export const foreignKeyRefSchema = z.object({
  tableId: nodeIdSchema,
  fieldId: fieldIdSchema.optional(),
  onDelete: z.enum(['restrict', 'cascade', 'setNull']).optional(),
});

export const fieldConstraintsSchema = z.object({
  minLength: z.number().int().nonnegative().optional(),
  maxLength: z.number().int().positive().optional(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
  pattern: z.string().optional(),
  enumRef: enumIdSchema.optional(),
  enumValues: z.array(z.string()).optional(),
  default: z.unknown().optional(),
  precision: z.number().int().positive().optional(),
  scale: z.number().int().nonnegative().optional(),
  arrayItem: fieldTypeSchema.optional(),
  ref: foreignKeyRefSchema.optional(),
});

export const fieldSchema = z.object({
  id: fieldIdSchema,
  name: z
    .string()
    .min(1)
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, '字段名必须是合法标识符'),
  dbName: z
    .string()
    .regex(/^[a-z_][a-z0-9_]*$/, '物理列名必须是 snake_case')
    .optional(),
  type: fieldTypeSchema,
  comment: z.string().optional(),
  description: z.string().optional(),
  required: z.boolean(),
  nullable: z.boolean(),
  readOnly: z.boolean().optional(),
  writeOnly: z.boolean().optional(),
  sensitive: z.boolean().optional(),
  deprecated: z.boolean().optional(),
  constraints: fieldConstraintsSchema.optional(),
  example: z.unknown().optional(),
  locked: z.boolean().optional(),
  port: z
    .object({
      visible: z.boolean(),
      order: z.number().int(),
    })
    .optional(),
});

// ────────────────────────────── 节点 ──────────────────────────────

const nodeBaseShape = {
  id: nodeIdSchema,
  name: z.string().min(1),
  codeName: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, '代码标识必须是合法标识符'),
  canvasId: canvasIdSchema,
  position: z.object({ x: z.number(), y: z.number() }),
  size: z.object({ w: z.number().positive(), h: z.number().positive() }),
  collapsed: z.boolean(),
  color: z.string().optional(),
  tags: z.array(z.string()),
  notes: z.string().optional(),
  locked: z.boolean().optional(),
};

export const indexDefSchema = z.object({
  id: indexIdSchema,
  name: z.string().optional(),
  fieldIds: z.array(fieldIdSchema),
  unique: z.boolean(),
});

export const tableDefSchema = z.object({
  dbName: z
    .string()
    .regex(/^[a-z_][a-z0-9_]*$/, '物理表名必须是 snake_case'),
  comment: z.string().optional(),
  fields: z.array(fieldSchema),
  indexes: z.array(indexDefSchema),
  softDelete: z.boolean(),
  timestamps: z.boolean(),
});

export const tableNodeSchema = z.object({
  ...nodeBaseShape,
  kind: z.literal('table'),
  table: tableDefSchema,
});

export const bodyDefSchema = z.object({
  shape: z.enum(['object', 'array', 'raw']),
  fields: z.array(fieldSchema),
  contentType: z.string().optional(),
  required: z.boolean(),
});

export const responseDefSchema = z.object({
  status: z.number().int().min(100).max(599),
  description: z.string(),
  fields: z.array(fieldSchema),
  shape: z.enum(['object', 'array', 'raw', 'empty']),
  envelope: z
    .object({
      dataKey: z.string(),
      totalKey: z.string().optional(),
    })
    .optional(),
});

export const apiDefSchema = z.object({
  method: httpMethodSchema,
  path: z
    .string()
    .regex(/^\//, '路径必须以 / 开头')
    .refine((p) => !p.includes('//'), '路径不能包含连续的 //'),
  summary: z.string(),
  description: z.string().optional(),
  tags: z.array(z.string()),
  auth: authModeSchema,
  deprecated: z.boolean().optional(),
  pathParams: z.array(fieldSchema),
  query: z.array(fieldSchema),
  headers: z.array(fieldSchema),
  requestBody: bodyDefSchema.optional(),
  responses: z.array(responseDefSchema).min(1, '接口至少要有一条响应'),
});

export const apiNodeSchema = z.object({
  ...nodeBaseShape,
  kind: z.literal('api'),
  api: apiDefSchema,
});

// ────────────────────────────── 页面组件 ──────────────────────────────

export const validationRuleSchema = z.object({
  type: z
    .enum(['required', 'min', 'max', 'len', 'pattern', 'email', 'url', 'custom'])
    .optional(),
  value: z.unknown().optional(),
  message: z.string(),
  trigger: z.enum(['blur', 'change']).optional(),
});

export const fieldBindingSchema = z.object({
  fieldRef: fieldIdSchema,
  label: z.string().optional(),
  control: z
    .enum([
      'input',
      'textarea',
      'number',
      'select',
      'radio',
      'checkbox',
      'switch',
      'date',
      'datetime',
      'upload',
      'cascader',
      'slot',
    ])
    .optional(),
  span: z.number().int().min(1).max(24).optional(),
  placeholder: z.string().optional(),
  rules: z.array(validationRuleSchema).optional(),
});

const componentBaseShape = {
  id: componentIdSchema,
  title: z.string().optional(),
  visibleWhen: z.string().optional(),
  bindings: z.array(fieldBindingSchema),
};

export const searchFormComponentSchema = z.object({
  ...componentBaseShape,
  type: z.literal('searchForm'),
  inline: z.boolean(),
  collapsible: z.boolean(),
  apiRef: nodeIdSchema,
});

export const tableColumnSchema = z.object({
  fieldRef: fieldIdSchema,
  width: z.number().positive().optional(),
  align: z.enum(['left', 'center', 'right']).optional(),
  sortable: z.boolean().optional(),
  ellipsis: z.boolean().optional(),
  formatter: z.string().optional(),
});

const actionComponentSchema = z.object({
  ...componentBaseShape,
  type: z.literal('action'),
  trigger: z.object({
    event: z.enum(['click', 'submit']),
    componentId: componentIdSchema.optional(),
  }),
  apiRef: nodeIdSchema.optional(),
  navigateTo: z.string().optional(),
  confirm: z.object({ text: z.string() }).optional(),
  level: z.enum(['primary', 'default', 'danger']).optional(),
});

export const tableComponentSchema = z.object({
  ...componentBaseShape,
  type: z.literal('table'),
  apiRef: nodeIdSchema,
  rowKeyFieldRef: fieldIdSchema.optional(),
  pagination: z.object({
    mode: z.enum(['server', 'client']),
    pageSize: z.number().int().positive(),
  }),
  columns: z.array(tableColumnSchema),
  rowActions: z.array(actionComponentSchema),
  selection: z.enum(['none', 'single', 'multiple']),
});

export const formComponentSchema = z.object({
  ...componentBaseShape,
  type: z.literal('form'),
  mode: z.enum(['create', 'edit']),
  apiRef: nodeIdSchema,
  loadApiRef: nodeIdSchema.optional(),
  layout: z.enum(['horizontal', 'vertical']),
  submitText: z.string(),
});

export const detailComponentSchema = z.object({
  ...componentBaseShape,
  type: z.literal('detail'),
  apiRef: nodeIdSchema,
  columns: z.union([z.literal(1), z.literal(2), z.literal(3)]),
});

export const tabsComponentSchema = z.object({
  ...componentBaseShape,
  type: z.literal('tabs'),
  tabs: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      componentIds: z.array(componentIdSchema),
    }),
  ),
  activeKey: z.string().optional(),
});

export const cardComponentSchema = z.object({
  ...componentBaseShape,
  type: z.literal('card'),
  componentIds: z.array(componentIdSchema),
  shadow: z.enum(['always', 'hover', 'never']),
});

export const pageComponentSchema = z.discriminatedUnion('type', [
  searchFormComponentSchema,
  tableComponentSchema,
  formComponentSchema,
  detailComponentSchema,
  actionComponentSchema,
  tabsComponentSchema,
  cardComponentSchema,
]);

export const pageDefSchema = z.object({
  route: z
    .string()
    .regex(/^\//, '页面路由必须以 / 开头'),
  title: z.string(),
  layout: pageLayoutSchema,
  components: z.array(pageComponentSchema),
});

export const pageNodeSchema = z.object({
  ...nodeBaseShape,
  kind: z.literal('page'),
  page: pageDefSchema,
});

export const noteNodeSchema = z.object({
  ...nodeBaseShape,
  kind: z.literal('note'),
  note: z.object({
    text: z.string(),
    groupId: z.string().optional(),
  }),
});

export const irNodeSchema = z.discriminatedUnion('kind', [
  tableNodeSchema,
  apiNodeSchema,
  pageNodeSchema,
  noteNodeSchema,
]);

// ────────────────────────────── 连线 ──────────────────────────────

export const edgeEndpointSchema = z.object({
  nodeId: nodeIdSchema,
  fieldId: fieldIdSchema.optional(),
  port: z.enum(['in', 'out']).optional(),
});

export const edgeTransformSchema = z.object({
  fn: z.enum(['identity', 'trim', 'toNumber', 'toString', 'dateFormat', 'lookup', 'custom']),
  args: z.array(z.unknown()).optional(),
  expression: z.string().optional(),
});

export const callTriggerSchema = z.object({
  // mount 事件没有发起组件，故可选；其余事件由 Lint 规则要求必填
  componentId: componentIdSchema.optional(),
  event: z.enum(['click', 'submit', 'mount', 'change']),
});

export const navigateInfoSchema = z.object({
  params: z.record(z.string(), z.string()).optional(),
  query: z.record(z.string(), z.string()).optional(),
});

export const irEdgeSchema = z.object({
  id: edgeIdSchema,
  kind: edgeKindSchema,
  source: edgeEndpointSchema,
  target: edgeEndpointSchema,
  label: z.string().optional(),
  transform: edgeTransformSchema.optional(),
  trigger: callTriggerSchema.optional(),
  nav: navigateInfoSchema.optional(),
  canvasId: canvasIdSchema,
});

// ────────────────────────────── 字典 ──────────────────────────────

export const enumValueSchema = z.object({
  value: z.string(),
  label: z.string().optional(),
  weight: z.number().positive().optional(),
  color: z.string().optional(),
});

export const enumDefSchema = z.object({
  id: enumIdSchema,
  name: z
    .string()
    .regex(/^[A-Z][A-Za-z0-9]*$/, '枚举名必须是 PascalCase'),
  description: z.string().optional(),
  values: z.array(enumValueSchema).min(1, '枚举至少要有一个值'),
});

export const modelDefSchema = z.object({
  id: modelIdSchema,
  name: z
    .string()
    .regex(/^[A-Z][A-Za-z0-9]*$/, '类型名必须是 PascalCase'),
  description: z.string().optional(),
  fields: z.array(fieldSchema),
});

// ────────────────────────────── 设置 ──────────────────────────────

export const frontendSettingsSchema = z.object({
  framework: z.literal('vue'),
  ui: z.enum(['element-plus', 'naive-ui', 'ant-design-vue']),
  apiStyle: z.enum(['script-setup', 'options']),
  packageManager: z.enum(['pnpm', 'npm', 'yarn']),
  stateSolution: z.literal('pinia'),
  requestLib: z.enum(['axios', 'ofetch']),
  strictness: z.literal('strict'),
});

export const backendSettingsSchema = z.object({
  framework: z.literal('nestjs'),
  orm: z.enum(['prisma', 'typeorm']),
  validation: z.literal('class-validator'),
  swagger: z.boolean(),
  auth: z.enum(['none', 'jwt']),
});

export const namingSettingsSchema = z.object({
  tableCase: z.enum(['snake', 'camel']),
  fieldCase: z.enum(['camel', 'snake']),
  pathCase: z.enum(['kebab', 'snake']),
  fileCase: z.enum(['kebab', 'pascal']),
});

export const generationSettingsSchema = z.object({
  outDir: z.string().min(1),
  sampleCount: z.number().int().min(1).max(1000),
  sampleSeed: z.number().int(),
  aiEnabled: z.boolean(),
  aiProvider: z.enum(['openai', 'anthropic', 'openai-compatible']).optional(),
  aiModel: z.string().optional(),
});

export const importSettingsSchema = z.object({
  candidateAutoAcceptThreshold: z.number().min(0).max(1),
  candidateManualThreshold: z.number().min(0).max(1),
  visionProvider: z.enum(['openai-vision', 'custom']).optional(),
});

export const exportSettingsSchema = z.object({
  image: z.enum(['png', 'svg']),
  structure: z.enum(['json', 'mermaid', 'drawio', 'figma']),
  includeFieldPorts: z.boolean(),
});

export const lintSettingsSchema = z.object({
  enabled: z.boolean(),
  blockOnError: z.boolean(),
  ruleOverrides: z.record(z.string(), z.enum(['off', 'info', 'warn', 'error'])),
  ignores: z.array(
    z.object({
      ruleId: z.string(),
      targetId: z.string(),
      reason: z.string().min(1, '忽略理由不能为空，否则三个月后没人知道为什么'),
    }),
  ),
});

export const projectSettingsSchema = z.object({
  frontend: frontendSettingsSchema,
  backend: backendSettingsSchema,
  naming: namingSettingsSchema,
  generation: generationSettingsSchema,
  import: importSettingsSchema,
  export: exportSettingsSchema,
  lint: lintSettingsSchema,
});

// ────────────────────────────── 画布与素材 ──────────────────────────────

export const canvasBackgroundSchema = z.object({
  assetId: assetIdSchema,
  opacity: z.number().min(0).max(1),
  locked: z.boolean(),
  fit: z.enum(['contain', 'width']),
  offset: z.object({ x: z.number(), y: z.number() }),
  scale: z.number().positive(),
});

export const canvasSchema = z.object({
  id: canvasIdSchema,
  name: z.string().min(1),
  order: z.number().int(),
  viewport: z.object({ x: z.number(), y: z.number(), zoom: z.number().positive() }),
  background: canvasBackgroundSchema.optional(),
  grid: z.object({ enabled: z.boolean(), size: z.number().positive() }),
});

export const assetSourceSchema = z.discriminatedUnion('channel', [
  z.object({
    channel: z.literal('figma'),
    fileKey: z.string(),
    nodeId: z.string(),
    fileVersion: z.string(),
  }),
  z.object({
    channel: z.literal('upload'),
    filename: z.string(),
  }),
]);

export const assetSchema = z.object({
  id: assetIdSchema,
  kind: z.enum(['design', 'screenshot', 'figma-export']),
  path: z.string().min(1),
  width: z.number().positive(),
  height: z.number().positive(),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/, 'sha256 必须是 64 位小写十六进制'),
  source: assetSourceSchema.optional(),
  createdAt: isoDateTime,
});

// ────────────────────────────── 顶层 ──────────────────────────────

export const projectMetaSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  packageScope: z.string().optional(),
});

export const irMetaSchema = z.object({
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
  generator: z.string(),
});

export const irSchema = z.object({
  schemaVersion: z.literal(1),
  project: projectMetaSchema,
  canvases: z.array(canvasSchema).min(1, '至少需要一块画布'),
  nodes: z.array(irNodeSchema),
  edges: z.array(irEdgeSchema),
  dictionaries: z.object({
    enums: z.array(enumDefSchema),
    models: z.array(modelDefSchema),
  }),
  assets: z.array(assetSchema),
  settings: projectSettingsSchema,
  meta: irMetaSchema,
});

export type IRSchemaInput = z.input<typeof irSchema>;
export type IRSchemaOutput = z.output<typeof irSchema>;
