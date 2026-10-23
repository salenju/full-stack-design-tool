/**
 * IR → UI Schema。
 *
 * 为什么需要这一层：OpenAPI 里没有「页面」这个词汇——它只知道接口，不知道接口被谁调用、
 * 结果渲染成表格还是表单、点按钮跳到哪里。这些信息只在画布的 `PageNode` + 连线里。
 * 所以「让 AI 生成页面」必须喂一份 UI Schema，光有 OpenAPI 只能生成类型化 HTTP 客户端。
 *
 * 本模块产出的 UI Schema 是**代码生成器的唯一输入**：Vue 生成器不直接读 IR，
 * 它读 UI Schema。好处是将来换前端框架（React/Svelte）时只需新写一个消费 UI Schema
 * 的生成器，不用重写一遍「页面语义 → 组件」的推导逻辑。
 *
 * 三条约束：
 * 1. **字段一律用 `prop`（字段名）而不是字段 ID 暴露给生成器**，但同时在 `fieldIds` 里
 *    保留反向映射，用于重命名后追溯与增量更新。
 * 2. **dataSources 必须能解析到真实接口**；解析不到的引用记为 warning 并从列表剔除，
 *    不让生成器拿到 `operationId: undefined` 这种半成品。
 * 3. **不猜布局。** 组件的顺序沿用 IR 中的声明顺序，生成器按顺序堆叠；不做「搜索表单
 *    放最上面、表格放中间」这类智能推断——推断错了用户改不动。
 */

import {
  buildGraphIndex,
  getNode,
  toCamelCase,
  type ApiNode,
  type Field,
  type FieldBinding,
  type FieldType,
  type IR,
  type PageComponent,
  type PageNode,
  type ValidationRule,
} from '@fsdt/core-ir';

import { allocateOperationIds } from '../common/operation-ids.js';

// ────────────────────────────── 输出的数据结构 ──────────────────────────────

export interface FormRule {
  kind: 'required' | 'min' | 'max' | 'len' | 'pattern' | 'email' | 'url' | 'custom';
  value?: unknown;
  message: string;
  trigger?: 'blur' | 'change';
}

export interface FieldSchema {
  /** 提交/读取用的属性名（camelCase） */
  prop: string;
  /** 原始字段 ID，供增量更新与重命名追溯 */
  fieldId: string;
  label: string;
  /** Element Plus 控件名（生成器直接写进模板） */
  control: string;
  type: string;
  span?: number;
  placeholder?: string;
  /** 是否必填（合并了字段自身与 binding.rules） */
  required: boolean;
  rules: FormRule[];
  /** 枚举取值，已从 enumRef 解析成字面量 */
  enumValues?: string[];
  /**
   * 枚举值 → 显示名。生成器要拿它渲染 `<el-option label>`：
   * 只给 enumValues 的话，下拉框里显示的是 `ACTIVE` 而不是「在线」，
   * 而这个「翻译」信息只在字典节点里，生成器自己查不到。
   */
  enumLabels?: Record<string, string>;
  /** 该字段在契约里的 JSON Schema 类型描述，供生成器写 TS 类型 */
  tsType: string;
  /**
   * 只读字段（如 createdAt / id）。
   * 生成器据此把控件渲染成 disabled：表单里保留位置让人看得见，但不让人改。
   */
  readOnly?: boolean;
}

export interface ColumnSchema {
  prop: string;
  fieldId: string;
  label: string;
  /** 字段类型（IR 原始类型），生成器按它决定对齐/格式化 */
  type: FieldType;
  /**
   * TS 类型。必须带上：只给 prop 的话，生成器写 `ref<Record<string, unknown>>`
   * 再绑到 `<el-input v-model>` 就是一片 TS2322（unknown 不能赋给 string）。
   */
  tsType: string;
  width?: number;
  align?: 'left' | 'center' | 'right';
  sortable?: boolean;
  ellipsis?: boolean;
  /** 受限表达式，生成器原样写进 el-table-column 的 formatter 或 template */
  formatter?: string;
  /** 枚举映射：值 → 显示名，生成器用来渲染 tag */
  enumMap?: Record<string, string>;
}

export interface ActionSchema {
  id: string;
  label: string;
  level?: 'primary' | 'default' | 'danger';
  /** 点击后调用的接口 */
  api?: { operationId: string; method: string; path: string };
  navigateTo?: string;
  /** 二次确认文案 */
  confirm?: string;
}

/** 数据源涉及到的单个字段：名字 + 推导出的 TS 类型 */
export interface DataFieldSchema {
  prop: string;
  tsType: string;
}

export interface DataSourceSchema {
  operationId: string;
  method: string;
  path: string;
  /**
   * 响应体形状。生成器要靠它决定「怎么取数据」：
   * - `list`：响应是 `{ items, total }` 信封 → `res.items`
   * - `object`：响应就是一行数据 → 直接用
   * - `raw`：无固定结构（文件流等）→ 交给调用方处理
   * 这个信息在 OpenAPI 里是有的，但 UI Schema 若不带，生成器只能猜。
   */
  responseShape: 'list' | 'object' | 'raw';
  /** list 形状下装数据的键名，默认 `items` */
  dataKey?: string;
  /** list 形状下装总数的键名，默认 `total`；无分页时不出现 */
  totalKey?: string;
  /**
   * 该数据源在页面里被读到（渲染）的响应字段，用于裁剪类型与 mock。
   * 带 tsType 而不是裸字符串：字段名谁都能拼，类型推错只有 tsc 会在
   * 生成出来的项目里报错——而那时用户已经在另一个仓库里了。
   */
  responseFields: DataFieldSchema[];
  /** 该数据源被用作请求参数（查询条件 / 表单提交）的字段 */
  requestFields: DataFieldSchema[];
  /** 接口节点 ID，供反查 */
  apiNodeId: string;
}

export type ComponentSchema =
  | SearchFormSchema
  | TableSchema
  | FormSchema
  | DetailSchema
  | ActionGroupSchema
  | TabsSchema
  | CardSchema;

export interface ComponentBaseSchema {
  id: string;
  type: PageComponent['type'];
  title?: string;
  /** 受限布尔表达式，生成器写成 v-if */
  visibleWhen?: string;
}

export interface SearchFormSchema extends ComponentBaseSchema {
  type: 'searchForm';
  inline: boolean;
  collapsible: boolean;
  fields: FieldSchema[];
  /** 提交后调用的接口 */
  api?: { operationId: string; method: string; path: string };
}

export interface TableSchema extends ComponentBaseSchema {
  type: 'table';
  columns: ColumnSchema[];
  rowKey?: string;
  pagination: { mode: 'server' | 'client'; pageSize: number };
  selection: 'none' | 'single' | 'multiple';
  rowActions: ActionSchema[];
  api?: { operationId: string; method: string; path: string };
}

export interface FormSchema extends ComponentBaseSchema {
  type: 'form';
  mode: 'create' | 'edit';
  layout: 'horizontal' | 'vertical';
  submitText: string;
  fields: FieldSchema[];
  api?: { operationId: string; method: string; path: string };
  /** 编辑时的回显接口 */
  loadApi?: { operationId: string; method: string; path: string };
}

export interface DetailSchema extends ComponentBaseSchema {
  type: 'detail';
  columns: 1 | 2 | 3;
  fields: FieldSchema[];
  api?: { operationId: string; method: string; path: string };
}

export interface ActionGroupSchema extends ComponentBaseSchema {
  type: 'action';
  actions: ActionSchema[];
}

export interface TabsSchema extends ComponentBaseSchema {
  type: 'tabs';
  tabs: Array<{ key: string; label: string; componentIds: string[] }>;
  activeKey?: string;
}

export interface CardSchema extends ComponentBaseSchema {
  type: 'card';
  componentIds: string[];
  shadow: 'always' | 'hover' | 'never';
}

export interface PageSchema {
  /** 页面节点 ID */
  id: string;
  route: string;
  title: string;
  /** 代码里的组件名（PascalCase），如 DeviceList */
  componentName: string;
  layout: PageNode['page']['layout'];
  components: ComponentSchema[];
  /** 本页用到的接口；没有则为空数组（不让下游 TS 报未定义类型） */
  dataSources: DataSourceSchema[];
  /** 生成器建议的文件路径 */
  suggestPath: string;
  /** 页面级守卫：进入时必须已调用的接口（来自 mount 事件连线） */
  mountApi?: { operationId: string; method: string; path: string };
}

export interface UiSchemaResult {
  pages: PageSchema[];
  /**
   * 本页用到的枚举类型。
   *
   * 为什么单独带出来：`FieldSchema.tsType` 对枚举字段给的是 `DeviceStatus`
   * 这样的类型名，而这个名字的**定义**（`'ACTIVE' | 'OFFLINE'`）只存在于 IR
   * 的字典里。生成器拿不到定义就只能退化写 `string`，于是下拉框的 v-model
   * 失去类型约束、后端加了新枚举值前端也不会报错。
   */
  enums: EnumTypeSchema[];
  warnings: string[];
}

export interface EnumTypeSchema {
  /** TS 类型名，如 DeviceStatus */
  name: string;
  values: Array<{ value: string; label: string }>;
}

export interface EmitUiSchemaOptions {
  /** 路由前缀，默认 '' */
  routePrefix?: string;
  /** 生成文件根目录，默认 'src/views' */
  viewsDir?: string;
}

// ────────────────────────────── 实现 ──────────────────────────────

/** 与后端契约一致的 TS 类型名（用于生成器写 ref 与类型标注） */
function tsTypeOf(field: Field, enumNames: Map<string, string>): string {
  switch (field.type) {
    case 'string':
    case 'text':
    case 'date':
    case 'datetime':
    case 'file':
      return 'string';
    case 'number':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'enum': {
      const ref = field.constraints?.enumRef;
      if (ref !== undefined && enumNames.has(ref)) return enumNames.get(ref)!;
      const inline = field.constraints?.enumValues;
      if (inline !== undefined && inline.length > 0) return inline.map((v) => `'${v}'`).join(' | ');
      return 'string';
    }
    case 'array': {
      const item = field.constraints?.arrayItem ?? 'string';
      return `${tsTypeOf({ ...field, type: item, constraints: undefined }, enumNames)}[]`;
    }
    case 'ref':
      return 'string';
    case 'object':
    case 'json':
      return 'unknown';
    default:
      return 'unknown';
  }
}

/** Element Plus 控件推导：只看类型与 binding.control，不猜业务 */
function controlOf(field: Field, binding: FieldBinding | undefined): string {
  if (binding?.control !== undefined) return binding.control;
  switch (field.type) {
    case 'text':
      return 'textarea';
    case 'number':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'switch';
    case 'date':
      return 'date';
    case 'datetime':
      return 'datetime';
    case 'enum':
      return 'select';
    case 'file':
      return 'upload';
    case 'array':
      return 'select';
    default:
      return 'input';
  }
}

/** 合并「字段约束」与「binding 显式规则」为一份规则列表 */
function rulesOf(field: Field, binding: FieldBinding | undefined): FormRule[] {
  const rules: FormRule[] = [];
  const seen = new Set<string>();

  const push = (rule: FormRule) => {
    const key = `${rule.kind}:${String(rule.value)}`;
    if (seen.has(key)) return;
    seen.add(key);
    rules.push(rule);
  };

  if (field.required) {
    push({ kind: 'required', message: `${binding?.label ?? field.comment ?? field.name}不能为空`, trigger: 'blur' });
  }
  if (field.constraints?.minLength !== undefined) {
    push({ kind: 'min', value: field.constraints.minLength, message: `至少 ${field.constraints.minLength} 个字符`, trigger: 'blur' });
  }
  if (field.constraints?.maxLength !== undefined) {
    push({ kind: 'max', value: field.constraints.maxLength, message: `最多 ${field.constraints.maxLength} 个字符`, trigger: 'blur' });
  }
  if (field.constraints?.pattern !== undefined) {
    push({ kind: 'pattern', value: field.constraints.pattern, message: '格式不正确', trigger: 'blur' });
  }

  for (const explicit of binding?.rules ?? []) {
    push({
      kind: explicit.type ?? 'custom',
      ...(explicit.value !== undefined ? { value: explicit.value } : {}),
      message: explicit.message,
      ...(explicit.trigger !== undefined ? { trigger: explicit.trigger } : {}),
    });
  }

  return rules;
}

interface EmitContext {
  ir: IR;
  g: ReturnType<typeof buildGraphIndex>;
  operationByNodeId: Map<string, string>;
  /** operationId → 接口节点 ID（反向索引） */
  nodeIdByOperation: Map<string, string>;
  apiById: Map<string, ApiNode>;
  enumNameById: Map<string, string>;
  /** 表字段 ID → 字段定义（页面组件绑定的是表字段） */
  fieldById: Map<string, Field>;
  warnings: string[];
}

/** 对外输出的接口引用形状（不含内部节点 ID） */
interface ApiTarget {
  operationId: string;
  method: string;
  path: string;
}

/** 内部使用的接口引用：额外带上节点 ID，供 dataSources 反查 */
interface ApiRef extends ApiTarget {
  nodeId: string;
}

/** 转成对外形状：剥掉内部节点 ID */
function toTarget(ref: ApiRef): ApiTarget {
  return { operationId: ref.operationId, method: ref.method, path: ref.path };
}

function apiRefOf(ctx: EmitContext, nodeId: string | undefined): ApiRef | undefined {
  if (nodeId === undefined) return undefined;
  const api = ctx.apiById.get(nodeId);
  if (api === undefined) {
    ctx.warnings.push(`页面引用了不存在的接口节点 ${nodeId}，该数据源已被忽略`);
    return undefined;
  }
  const operationId = ctx.operationByNodeId.get(nodeId);
  if (operationId === undefined) {
    ctx.warnings.push(`接口节点 ${nodeId} 未分配到 operationId，该数据源已被忽略`);
    return undefined;
  }
  return { operationId, method: api.api.method, path: api.api.path, nodeId };
}

function fieldsOf(
  ctx: EmitContext,
  bindings: FieldBinding[],
  options: { withRules?: boolean } = {},
): FieldSchema[] {
  const out: FieldSchema[] = [];
  for (const binding of bindings) {
    const field = ctx.fieldById.get(binding.fieldRef);
    if (field === undefined) {
      // 组件绑定了不存在的字段：Lint L014 会报，这里继续产出其余字段而不是整页失败
      ctx.warnings.push(`组件绑定了不存在的字段 ${binding.fieldRef}，已跳过该字段`);
      continue;
    }
    const enumRef = field.constraints?.enumRef;
    const enumDef = enumRef !== undefined ? ctx.ir.dictionaries.enums.find((e) => e.id === enumRef) : undefined;
    const inline = field.constraints?.enumValues;

    const item: FieldSchema = {
      prop: field.name,
      fieldId: field.id,
      label: binding.label ?? field.comment ?? field.name,
      control: controlOf(field, binding),
      type: field.type,
      required: field.required,
      rules: options.withRules === false ? [] : rulesOf(field, binding),
      tsType: tsTypeOf(field, ctx.enumNameById),
    };
    if (binding.span !== undefined) item.span = binding.span;
    if (binding.placeholder !== undefined) item.placeholder = binding.placeholder;
    // 只在 true 时输出：false 与「没有这个属性」对生成器是同一件事，写出来只是噪音
    if (field.readOnly === true) item.readOnly = true;
    if (enumDef !== undefined) {
      item.enumValues = enumDef.values.map((v) => v.value);
      const labels: Record<string, string> = {};
      // label 在 IR 里是可选的（只给 value 时显示名即 value）
      for (const v of enumDef.values) labels[v.value] = v.label ?? v.value;
      item.enumLabels = labels;
    } else if (inline !== undefined && inline.length > 0) {
      item.enumValues = [...inline];
    }

    out.push(item);
  }
  return out;
}

function columnOf(ctx: EmitContext, col: TableComponentLike['columns'][number]): ColumnSchema | undefined {
  const field = ctx.fieldById.get(col.fieldRef);
  if (field === undefined) {
    ctx.warnings.push(`表格列绑定了不存在的字段 ${col.fieldRef}，已跳过`);
    return undefined;
  }
  const enumRef = field.constraints?.enumRef;
  const enumDef = enumRef !== undefined ? ctx.ir.dictionaries.enums.find((e) => e.id === enumRef) : undefined;

  const item: ColumnSchema = {
    prop: field.name,
    fieldId: field.id,
    label: field.comment ?? field.name,
    type: field.type,
    tsType: tsTypeOf(field, ctx.enumNameById),
  };
  if (col.width !== undefined) item.width = col.width;
  if (col.align !== undefined) item.align = col.align;
  if (col.sortable !== undefined) item.sortable = col.sortable;
  if (col.ellipsis !== undefined) item.ellipsis = col.ellipsis;
  if (col.formatter !== undefined) item.formatter = col.formatter;
  if (enumDef !== undefined) {
    item.enumMap = Object.fromEntries(enumDef.values.map((v) => [v.value, v.label ?? v.value]));
  }
  return item;
}

type TableComponentLike = Extract<PageComponent, { type: 'table' }>;

function actionOf(ctx: EmitContext, action: Extract<PageComponent, { type: 'action' }>): ActionSchema {
  const item: ActionSchema = {
    id: action.id,
    label: action.title ?? (action.bindings[0]?.label ?? '操作'),
  };
  if (action.level !== undefined) item.level = action.level;
  const api = apiRefOf(ctx, action.apiRef);
  if (api !== undefined) item.api = toTarget(api);
  if (action.navigateTo !== undefined) item.navigateTo = action.navigateTo;
  if (action.confirm !== undefined) item.confirm = action.confirm.text;
  return item;
}

/** 行内操作（表格 rowActions）也允许绑定接口与跳转 */
function rowActionOf(ctx: EmitContext, action: PageComponent): ActionSchema | undefined {
  if (action.type !== 'action') return undefined;
  return actionOf(ctx, action);
}

function componentOf(ctx: EmitContext, component: PageComponent): ComponentSchema | undefined {
  switch (component.type) {
    case 'searchForm': {
      const schema: SearchFormSchema = {
        id: component.id,
        type: 'searchForm',
        inline: component.inline,
        collapsible: component.collapsible,
        fields: fieldsOf(ctx, component.bindings),
      };
      if (component.title !== undefined) schema.title = component.title;
      if (component.visibleWhen !== undefined) schema.visibleWhen = component.visibleWhen;
      const api = apiRefOf(ctx, component.apiRef);
      if (api !== undefined) schema.api = toTarget(api);
      return schema;
    }

    case 'table': {
      const columns: ColumnSchema[] = [];
      for (const col of component.columns) {
        const c = columnOf(ctx, col);
        if (c !== undefined) columns.push(c);
      }
      const schema: TableSchema = {
        id: component.id,
        type: 'table',
        columns,
        pagination: { ...component.pagination },
        selection: component.selection,
        rowActions: component.rowActions
          .map((a) => rowActionOf(ctx, a))
          .filter((a): a is ActionSchema => a !== undefined),
      };
      if (component.title !== undefined) schema.title = component.title;
      if (component.visibleWhen !== undefined) schema.visibleWhen = component.visibleWhen;
      if (component.rowKeyFieldRef !== undefined) {
        const key = ctx.fieldById.get(component.rowKeyFieldRef);
        if (key !== undefined) schema.rowKey = key.name;
      }
      const api = apiRefOf(ctx, component.apiRef);
      if (api !== undefined) schema.api = toTarget(api);
      return schema;
    }

    case 'form': {
      const schema: FormSchema = {
        id: component.id,
        type: 'form',
        mode: component.mode,
        layout: component.layout,
        submitText: component.submitText,
        fields: fieldsOf(ctx, component.bindings),
      };
      if (component.title !== undefined) schema.title = component.title;
      if (component.visibleWhen !== undefined) schema.visibleWhen = component.visibleWhen;
      const api = apiRefOf(ctx, component.apiRef);
      if (api !== undefined) schema.api = toTarget(api);
      const loadApi = apiRefOf(ctx, component.loadApiRef);
      if (loadApi !== undefined) schema.loadApi = toTarget(loadApi);
      return schema;
    }

    case 'detail': {
      const schema: DetailSchema = {
        id: component.id,
        type: 'detail',
        columns: component.columns,
        fields: fieldsOf(ctx, component.bindings, { withRules: false }),
      };
      if (component.title !== undefined) schema.title = component.title;
      if (component.visibleWhen !== undefined) schema.visibleWhen = component.visibleWhen;
      const api = apiRefOf(ctx, component.apiRef);
      if (api !== undefined) schema.api = toTarget(api);
      return schema;
    }

    case 'action': {
      const schema: ActionGroupSchema = {
        id: component.id,
        type: 'action',
        actions: [actionOf(ctx, component)],
      };
      if (component.title !== undefined) schema.title = component.title;
      if (component.visibleWhen !== undefined) schema.visibleWhen = component.visibleWhen;
      return schema;
    }

    case 'tabs': {
      const schema: TabsSchema = {
        id: component.id,
        type: 'tabs',
        tabs: component.tabs.map((t) => ({ key: t.key, label: t.label, componentIds: [...t.componentIds] })),
      };
      if (component.title !== undefined) schema.title = component.title;
      if (component.visibleWhen !== undefined) schema.visibleWhen = component.visibleWhen;
      if (component.activeKey !== undefined) schema.activeKey = component.activeKey;
      return schema;
    }

    case 'card': {
      const schema: CardSchema = {
        id: component.id,
        type: 'card',
        componentIds: [...component.componentIds],
        shadow: component.shadow,
      };
      if (component.title !== undefined) schema.title = component.title;
      if (component.visibleWhen !== undefined) schema.visibleWhen = component.visibleWhen;
      return schema;
    }

    default:
      return undefined;
  }
}

/**
 * 收集页面用到的数据源，并算出每个数据源被哪些响应字段消费。
 *
 * 「用到的响应字段」这个信息很关键：生成 TS 类型时只导出用到的字段，页面不会因为
 * 后端加了个没人用的字段就重新编译失败；mock 也只造这些字段，体积小一个数量级。
 */
function responseShapeOf(apiNodeId: string, ctx: EmitContext): {
  responseShape: 'list' | 'object' | 'raw';
  dataKey?: string;
  totalKey?: string;
} {
  const api = ctx.apiById.get(apiNodeId);
  if (api === undefined) return { responseShape: 'object' };
  // 取第一条 2xx 响应：契约里 200 与 201 表达的是同一份数据形状
  const response = api.api.responses.find((r) => r.status >= 200 && r.status < 300);
  if (response === undefined) return { responseShape: 'object' };
  if (response.shape === 'raw' || response.shape === 'empty') return { responseShape: 'raw' };
  if (response.shape === 'array' || response.envelope?.totalKey !== undefined) {
    const out: { responseShape: 'list'; dataKey: string; totalKey?: string } = {
      responseShape: 'list',
      dataKey: response.envelope?.dataKey ?? 'items',
    };
    if (response.envelope?.totalKey !== undefined) out.totalKey = response.envelope.totalKey;
    return out;
  }
  return { responseShape: 'object' };
}

/** 收集页面组件里出现过的 TS 类型名（用于反查枚举定义） */
function collectComponentTypes(components: ComponentSchema[], into: Set<string>): void {
  for (const component of components) {
    switch (component.type) {
      case 'searchForm':
      case 'form':
      case 'detail':
        for (const f of component.fields) into.add(f.tsType);
        break;
      case 'table':
        for (const c of component.columns) into.add(c.tsType);
        break;
      default:
        break;
    }
  }
}

/** FieldSchema[] → DataFieldSchema[]（prop + 推导出的 TS 类型） */
function pickDataFields(fields: FieldSchema[]): DataFieldSchema[] {
  return fields.map((f) => ({ prop: f.prop, tsType: f.tsType }));
}

function collectDataSources(
  ctx: EmitContext,
  components: ComponentSchema[],
  mountApi: ApiTarget | undefined,
): DataSourceSchema[] {
  const byOperationId = new Map<string, DataSourceSchema>();

  const merge = (into: DataFieldSchema[], fields: DataFieldSchema[]) => {
    for (const f of fields) {
      const hit = into.find((x) => x.prop === f.prop);
      if (hit === undefined) into.push({ ...f });
      // 同一 prop 出现多次时以**更窄**的类型为准：搜索表单里同名条件是 string，
      // 响应里可能是 string | null，取 string 才能通过 v-model 的类型检查
      else if (hit.tsType === 'unknown') hit.tsType = f.tsType;
    }
  };

  const add = (api: ApiTarget | undefined, request: DataFieldSchema[], response: DataFieldSchema[]) => {
    if (api === undefined) return;
    const existing = byOperationId.get(api.operationId);
    if (existing === undefined) {
      const apiNodeId = ctx.nodeIdByOperation.get(api.operationId) ?? '';
      byOperationId.set(api.operationId, {
        operationId: api.operationId,
        method: api.method,
        path: api.path,
        ...responseShapeOf(apiNodeId, ctx),
        responseFields: response.map((f) => ({ ...f })),
        requestFields: request.map((f) => ({ ...f })),
        apiNodeId,
      });
      return;
    }
    merge(existing.requestFields, request);
    merge(existing.responseFields, response);
  };

  add(mountApi, [], []);

  for (const component of components) {
    switch (component.type) {
      case 'searchForm':
        // 搜索表单的字段是查询参数，不是响应字段
        add(component.api, pickDataFields(component.fields), []);
        break;
      case 'table':
        add(component.api, [], component.columns.map((c) => ({ prop: c.prop, tsType: c.tsType })));
        break;
      case 'form':
        add(component.api, pickDataFields(component.fields), []);
        add(component.loadApi, [], pickDataFields(component.fields));
        break;
      case 'detail':
        add(component.api, [], pickDataFields(component.fields));
        break;
      case 'action':
        for (const a of component.actions) add(a.api, [], []);
        break;
      default:
        break;
    }
  }

  return [...byOperationId.values()].sort((a, b) => (a.operationId < b.operationId ? -1 : 1));
}

export function emitUiSchema(ir: IR, options: EmitUiSchemaOptions = {}): UiSchemaResult {
  const warnings: string[] = [];
  const g = buildGraphIndex(ir);
  const allocation = allocateOperationIds(ir);
  warnings.push(...allocation.warnings);

  const apiById = new Map<string, ApiNode>();
  for (const node of ir.nodes) {
    if (node.kind === 'api') apiById.set(node.id, node);
  }

  const enumNameById = new Map<string, string>();
  for (const def of ir.dictionaries.enums) enumNameById.set(def.id, def.name);

  // 字段索引：页面组件绑定的是「表字段」，所以遍历所有表的字段
  const fieldById = new Map<string, Field>();
  for (const table of g.tables.values()) {
    for (const f of table.table.fields) fieldById.set(f.id, f);
  }

  const nodeIdByOperation = new Map<string, string>();
  for (const [nodeId, opId] of allocation.byNodeId) nodeIdByOperation.set(opId, nodeId);

  const ctx: EmitContext = {
    ir,
    g,
    operationByNodeId: allocation.byNodeId,
    nodeIdByOperation,
    apiById,
    enumNameById,
    fieldById,
    warnings,
  };

  const routePrefix = options.routePrefix ?? '';
  const viewsDir = options.viewsDir ?? 'src/views';
  const usedEnums = new Map<string, EnumTypeSchema>();

  const pages: PageSchema[] = [];
  const pageNodes = ir.nodes
    .filter((n): n is PageNode => n.kind === 'page')
    .slice()
    .sort((a, b) => (a.page.route < b.page.route ? -1 : a.page.route > b.page.route ? 1 : 0));

  for (const node of pageNodes) {
    const components: ComponentSchema[] = [];
    for (const raw of node.page.components) {
      const c = componentOf(ctx, raw);
      if (c !== undefined) components.push(c);
    }

    // mount 事件连线：页面一加载就调用的接口
    const mountEdge = g.edgesByNode.get(node.id)?.find((e) => {
      if (e.kind !== 'call') return false;
      if (e.source.nodeId !== node.id) return false;
      return e.trigger?.event === 'mount';
    });
    const mountApi = mountEdge !== undefined ? apiRefOf(ctx, mountEdge.target.nodeId) : undefined;

    const componentName = toCamelCase(node.codeName || node.name) || 'Page';
    const suggestPath = `${viewsDir}/${node.page.route.replace(/^\//, '').replace(/\//g, '-') || 'index'}.vue`;

    const schema: PageSchema = {
      id: node.id,
      route: `${routePrefix}${node.page.route}`,
      title: node.page.title,
      componentName: componentName.charAt(0).toUpperCase() + componentName.slice(1),
      layout: node.page.layout,
      components,
      dataSources: collectDataSources(ctx, components, mountApi),
      suggestPath,
    };
    if (mountApi !== undefined) schema.mountApi = toTarget(mountApi);
    pages.push(schema);
  }

  // 只带出**页面真正用到**的枚举：全量输出会让生成出来的 types.gen.ts
  // 出现一堆没人用的类型，而这些类型又必须与后端同步，白增维护面。
  const referencedTypes = new Set<string>();
  for (const page of pages) {
    for (const ds of page.dataSources) {
      for (const f of [...ds.requestFields, ...ds.responseFields]) referencedTypes.add(f.tsType);
    }
    collectComponentTypes(page.components, referencedTypes);
  }
  for (const def of ir.dictionaries.enums) {
    if (!referencedTypes.has(def.name)) continue;
    usedEnums.set(def.name, {
      name: def.name,
      values: def.values.map((v) => ({ value: v.value, label: v.label ?? v.value })),
    });
  }

  return {
    pages,
    enums: [...usedEnums.values()].sort((a, b) => (a.name < b.name ? -1 : 1)),
    warnings: [...new Set(warnings)],
  };
}

/** 供生成器反查：某字段属于哪张表（用于编辑页的默认值） */
export function fieldOwnerTable(ir: IR, fieldId: string): string | undefined {
  for (const node of ir.nodes) {
    if (node.kind !== 'table') continue;
    if (node.table.fields.some((f) => f.id === fieldId)) return node.id;
  }
  return undefined;
}

/** 供路由生成用：页面路由 → Vue Router 的 path（带参数） */
export function toRouterPath(page: PageSchema): string {
  return page.route;
}

/** 供生成器用：一个页面里所有需要编辑的字段（去重） */
export function collectPageProps(page: PageSchema): string[] {
  const props = new Set<string>();
  for (const c of page.components) {
    if ('fields' in c) for (const f of c.fields) props.add(f.prop);
    if (c.type === 'table') for (const col of c.columns) props.add(col.prop);
  }
  return [...props];
}

export type { ApiNode, ValidationRule };
