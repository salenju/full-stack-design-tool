/**
 * 默认值构造器。
 *
 * 原则：**新建的 IR 必须能直接通过 schema 校验并被编译**，即「默认值即合法值」。
 * 这样新建项目、新建节点都不需要额外的补救逻辑，也让 fixture 手写成本最低。
 */

import { newCanvasId, newComponentId, newFieldId, newNodeId } from './ids.js';
import type {
  ApiNode,
  Asset,
  Canvas,
  Field,
  FieldType,
  FormComponent,
  IR,
  NoteNode,
  PageComponent,
  PageNode,
  ProjectSettings,
  SearchFormComponent,
  TableComponent,
  TableNode,
  FieldBinding,
  ActionComponent,
} from './types.js';

export const IR_SCHEMA_VERSION = 1;
export const GENERATOR_ID = 'fsdt@0.1.0';

/**
 * 各字段类型的**结构性**默认约束。
 *
 * 只给「不给就没法表达」的东西：
 * - `array` 必须有元素类型，否则 schema 里 `items` 缺失；
 * - `enum` 必须有取值来源（空数组会被 Lint IR003 报出来，这是刻意的）。
 *
 * 刻意**不**给 string/text 默认 `minLength/maxLength`。理由：
 * 那会把「用户没声明约束」变成「用户声明了 1–255」，于是 OpenAPI、class-validator
 * DTO、前端表单规则里都会凭空多出一条没人要求的长度限制；等后端开始拒绝超长输入时，
 * 没人知道这条规则是哪来的。约束只能来自用户的明确输入。
 */
export function defaultConstraintsFor(type: FieldType): Field['constraints'] {
  switch (type) {
    case 'array':
      return { arrayItem: 'string' };
    case 'enum':
      return { enumValues: [] };
    default:
      return undefined;
  }
}

export interface CreateFieldInput {
  id?: string;
  name: string;
  type?: FieldType;
  dbName?: string;
  comment?: string;
  description?: string;
  required?: boolean;
  nullable?: boolean;
  readOnly?: boolean;
  writeOnly?: boolean;
  sensitive?: boolean;
  deprecated?: boolean;
  example?: unknown;
  locked?: boolean;
  constraints?: Field['constraints'];
  port?: Field['port'];
}

export function createField(input: CreateFieldInput): Field {
  const type = input.type ?? 'string';
  const field: Field = {
    id: input.id ?? newFieldId(),
    name: input.name,
    type,
    required: input.required ?? true,
    nullable: input.nullable ?? false,
  };
  if (input.dbName !== undefined) field.dbName = input.dbName;
  if (input.comment !== undefined) field.comment = input.comment;
  if (input.description !== undefined) field.description = input.description;
  if (input.readOnly !== undefined) field.readOnly = input.readOnly;
  if (input.writeOnly !== undefined) field.writeOnly = input.writeOnly;
  if (input.sensitive !== undefined) field.sensitive = input.sensitive;
  if (input.deprecated !== undefined) field.deprecated = input.deprecated;
  if (input.example !== undefined) field.example = input.example;
  if (input.locked !== undefined) field.locked = input.locked;
  if (input.port !== undefined) field.port = input.port;
  const constraints = input.constraints ?? defaultConstraintsFor(type);
  if (constraints !== undefined) field.constraints = constraints;
  return field;
}

export function createTableNode(partial: Partial<TableNode> & { name?: string } = {}): TableNode {
  const name = partial.name ?? '新数据表';
  return {
    id: partial.id ?? newNodeId(),
    kind: 'table',
    name,
    codeName: partial.codeName ?? 'NewTable',
    canvasId: partial.canvasId ?? '',
    position: partial.position ?? { x: 0, y: 0 },
    size: partial.size ?? { w: 260, h: 200 },
    collapsed: partial.collapsed ?? false,
    tags: partial.tags ?? [],
    ...(partial.color !== undefined ? { color: partial.color } : {}),
    ...(partial.notes !== undefined ? { notes: partial.notes } : {}),
    ...(partial.locked !== undefined ? { locked: partial.locked } : {}),
    table: partial.table ?? {
      dbName: 'new_table',
      fields: [],
      indexes: [],
      softDelete: false,
      timestamps: true,
    },
  };
}

export function createApiNode(partial: Partial<ApiNode> & { name?: string } = {}): ApiNode {
  const name = partial.name ?? '新接口';
  return {
    id: partial.id ?? newNodeId(),
    kind: 'api',
    name,
    codeName: partial.codeName ?? 'newOperation',
    canvasId: partial.canvasId ?? '',
    position: partial.position ?? { x: 0, y: 0 },
    size: partial.size ?? { w: 280, h: 220 },
    collapsed: partial.collapsed ?? false,
    tags: partial.tags ?? [],
    ...(partial.color !== undefined ? { color: partial.color } : {}),
    ...(partial.notes !== undefined ? { notes: partial.notes } : {}),
    ...(partial.locked !== undefined ? { locked: partial.locked } : {}),
    api: partial.api ?? {
      method: 'GET',
      path: '/new-resource',
      summary: '待补充说明',
      tags: [],
      auth: 'none',
      pathParams: [],
      query: [],
      headers: [],
      responses: [{ status: 200, description: '成功', fields: [], shape: 'object' }],
    },
  };
}

export function createPageNode(partial: Partial<PageNode> & { name?: string } = {}): PageNode {
  const name = partial.name ?? '新页面';
  return {
    id: partial.id ?? newNodeId(),
    kind: 'page',
    name,
    codeName: partial.codeName ?? 'NewPage',
    canvasId: partial.canvasId ?? '',
    position: partial.position ?? { x: 0, y: 0 },
    size: partial.size ?? { w: 300, h: 240 },
    collapsed: partial.collapsed ?? false,
    tags: partial.tags ?? [],
    ...(partial.color !== undefined ? { color: partial.color } : {}),
    ...(partial.notes !== undefined ? { notes: partial.notes } : {}),
    ...(partial.locked !== undefined ? { locked: partial.locked } : {}),
    page: partial.page ?? {
      route: '/new-page',
      title: name,
      layout: 'blank',
      components: [],
    },
  };
}

export function createNoteNode(partial: Partial<NoteNode> & { name?: string } = {}): NoteNode {
  const name = partial.name ?? '备注';
  return {
    id: partial.id ?? newNodeId(),
    kind: 'note',
    name,
    codeName: partial.codeName ?? 'note',
    canvasId: partial.canvasId ?? '',
    position: partial.position ?? { x: 0, y: 0 },
    size: partial.size ?? { w: 200, h: 120 },
    collapsed: partial.collapsed ?? false,
    tags: partial.tags ?? [],
    ...(partial.color !== undefined ? { color: partial.color } : {}),
    ...(partial.notes !== undefined ? { notes: partial.notes } : {}),
    ...(partial.locked !== undefined ? { locked: partial.locked } : {}),
    note: partial.note ?? { text: '' },
  };
}

export function createBinding(fieldRef: string, extra: Partial<FieldBinding> = {}): FieldBinding {
  return { fieldRef, ...extra };
}

export function createSearchForm(
  apiRef: string,
  bindings: FieldBinding[] = [],
  partial: Partial<SearchFormComponent> = {},
): SearchFormComponent {
  return {
    id: partial.id ?? newComponentId(),
    type: 'searchForm',
    bindings,
    inline: partial.inline ?? true,
    collapsible: partial.collapsible ?? false,
    apiRef,
    ...(partial.title !== undefined ? { title: partial.title } : {}),
    ...(partial.visibleWhen !== undefined ? { visibleWhen: partial.visibleWhen } : {}),
  };
}

export function createTable(
  apiRef: string,
  columns: TableComponent['columns'] = [],
  partial: Partial<TableComponent> = {},
): TableComponent {
  return {
    id: partial.id ?? newComponentId(),
    type: 'table',
    bindings: partial.bindings ?? [],
    apiRef,
    pagination: partial.pagination ?? { mode: 'server', pageSize: 20 },
    columns,
    rowActions: partial.rowActions ?? [],
    selection: partial.selection ?? 'none',
    ...(partial.title !== undefined ? { title: partial.title } : {}),
    ...(partial.visibleWhen !== undefined ? { visibleWhen: partial.visibleWhen } : {}),
    ...(partial.rowKeyFieldRef !== undefined ? { rowKeyFieldRef: partial.rowKeyFieldRef } : {}),
  };
}

export function createForm(
  apiRef: string,
  bindings: FieldBinding[] = [],
  partial: Partial<FormComponent> = {},
): FormComponent {
  return {
    id: partial.id ?? newComponentId(),
    type: 'form',
    bindings,
    mode: partial.mode ?? 'create',
    apiRef,
    layout: partial.layout ?? 'horizontal',
    submitText: partial.submitText ?? '保存',
    ...(partial.title !== undefined ? { title: partial.title } : {}),
    ...(partial.visibleWhen !== undefined ? { visibleWhen: partial.visibleWhen } : {}),
    ...(partial.loadApiRef !== undefined ? { loadApiRef: partial.loadApiRef } : {}),
  };
}

export function createAction(partial: Partial<ActionComponent> = {}): ActionComponent {
  return {
    id: partial.id ?? newComponentId(),
    type: 'action',
    bindings: partial.bindings ?? [],
    trigger: partial.trigger ?? { event: 'click' },
    ...(partial.title !== undefined ? { title: partial.title } : {}),
    ...(partial.apiRef !== undefined ? { apiRef: partial.apiRef } : {}),
    ...(partial.navigateTo !== undefined ? { navigateTo: partial.navigateTo } : {}),
    ...(partial.confirm !== undefined ? { confirm: partial.confirm } : {}),
    ...(partial.level !== undefined ? { level: partial.level } : {}),
  };
}

export function createCanvas(partial: Partial<Canvas> = {}): Canvas {
  return {
    id: partial.id ?? newCanvasId(),
    name: partial.name ?? '画布 1',
    order: partial.order ?? 0,
    viewport: partial.viewport ?? { x: 0, y: 0, zoom: 1 },
    grid: partial.grid ?? { enabled: true, size: 16 },
    ...(partial.background !== undefined ? { background: partial.background } : {}),
  };
}

export function createAsset(partial: Asset): Asset {
  return { ...partial };
}

export function defaultSettings(): ProjectSettings {
  return {
    frontend: {
      framework: 'vue',
      ui: 'element-plus',
      apiStyle: 'script-setup',
      packageManager: 'pnpm',
      stateSolution: 'pinia',
      requestLib: 'axios',
      strictness: 'strict',
    },
    backend: {
      framework: 'nestjs',
      orm: 'prisma',
      validation: 'class-validator',
      swagger: true,
      auth: 'none',
    },
    naming: {
      tableCase: 'snake',
      fieldCase: 'camel',
      pathCase: 'kebab',
      fileCase: 'kebab',
    },
    generation: {
      outDir: 'output',
      sampleCount: 20,
      sampleSeed: 42,
      aiEnabled: false,
    },
    import: {
      candidateAutoAcceptThreshold: 0.85,
      candidateManualThreshold: 0.5,
    },
    export: {
      image: 'svg',
      structure: 'json',
      includeFieldPorts: false,
    },
    lint: {
      enabled: true,
      blockOnError: true,
      ruleOverrides: {},
      ignores: [],
    },
  };
}

export interface CreateIRInput {
  projectName?: string;
  projectId?: string;
  now?: string;
}

/** 新建一个最小合法 IR：一个画布、无节点、无连线 */
export function createEmptyIR(input: CreateIRInput = {}): IR {
  const now = input.now ?? new Date().toISOString();
  const canvas = createCanvas({ name: '画布 1', order: 0 });
  return {
    schemaVersion: IR_SCHEMA_VERSION,
    project: {
      id: input.projectId ?? 'prj_default',
      name: input.projectName ?? '未命名项目',
    },
    canvases: [canvas],
    nodes: [],
    edges: [],
    dictionaries: { enums: [], models: [] },
    assets: [],
    settings: defaultSettings(),
    meta: { createdAt: now, updatedAt: now, generator: GENERATOR_ID },
  };
}

/** 组件类型 → 是否需要 apiRef，供 UI 与校验共用 */
export const COMPONENT_TYPES = [
  'searchForm',
  'table',
  'form',
  'detail',
  'action',
  'tabs',
  'card',
] as const;

export type ComponentType = (typeof COMPONENT_TYPES)[number];

export function isComponentType(value: string): value is ComponentType {
  return (COMPONENT_TYPES as readonly string[]).includes(value);
}

/** 深拷贝并重新分配所有 ID（用于「复制节点」与 fixture 生成） */
export function cloneComponents(components: PageComponent[]): PageComponent[] {
  const idMap = new Map<string, string>();
  for (const c of components) idMap.set(c.id, newComponentId());

  const remapAction = (a: ActionComponent): ActionComponent => {
    const next: ActionComponent = { ...a, id: idMap.get(a.id) ?? newComponentId() };
    if (a.trigger.componentId !== undefined) {
      const mapped = idMap.get(a.trigger.componentId);
      next.trigger = { ...a.trigger, ...(mapped !== undefined ? { componentId: mapped } : {}) };
    }
    return next;
  };

  return components.map((c): PageComponent => {
    switch (c.type) {
      case 'table':
        return { ...c, id: idMap.get(c.id) ?? newComponentId(), rowActions: c.rowActions.map(remapAction) };
      case 'tabs':
        return {
          ...c,
          id: idMap.get(c.id) ?? newComponentId(),
          tabs: c.tabs.map((t) => ({
            ...t,
            componentIds: t.componentIds.map((cid) => idMap.get(cid) ?? cid),
          })),
        };
      default:
        return { ...c, id: idMap.get(c.id) ?? newComponentId() };
    }
  });
}
