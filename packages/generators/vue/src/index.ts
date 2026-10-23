/**
 * Vue 3 代码生成器。
 *
 * 输入是 **UI Schema**（`@fsdt/compiler` 产出），不是 IR。理由见 emit-ui-schema.ts 文件头：
 * 「页面语义 → 组件」的推导只该有一份，将来写 React 生成器时复用同一份 UI Schema。
 *
 * 生成策略：**能展开就展开，不做运行时 schema 解释器**。
 * 理由是用户需要改生成结果——显式代码（每个表单项一行）比「循环渲染 fields[]」好改得多。
 * 只有字段数超过 `INLINE_THRESHOLD` 时才切到循环模式，避免生成上千行样板。
 *
 * 两条排版纪律（都是踩过坑的）：
 * 1. `<template>` 与 `<script>` 的内容**不再套一层缩进**。SFC 里顶层元素缩进是风格问题，
 *    但 `<script setup>` 里多套一层会让生成的代码与用户手写的对不齐，合并时满地冲突。
 * 2. 模板属性用双引号（HTML 语境），script 里的字符串用单引号——两种上下文分别处理。
 */

import { computeSchemaHash, toCamelCase, toPackageName, toPascalCase, type IR } from '@fsdt/core-ir';
import {
  emitUiSchema,
  type ActionSchema,
  type ColumnSchema,
  type ComponentSchema,
  type DataSourceSchema,
  type EnumTypeSchema,
  type FieldSchema,
  type PageSchema,
} from '@fsdt/compiler';
import { Writer, quote } from '@fsdt/generators-runtime';
import type { CodeGenerator, CompileContext, FilePlan, RenderedFile } from '@fsdt/generators-runtime';

export const GENERATOR_ID = 'vue';
export const GENERATOR_VERSION = '0.1.0';

/** 超过这个字段数就切循环渲染，避免生成超大文件 */
export const INLINE_THRESHOLD = 30;

type SearchFormSchema = Extract<ComponentSchema, { type: 'searchForm' }>;
type TableSchema = Extract<ComponentSchema, { type: 'table' }>;
type FormSchema = Extract<ComponentSchema, { type: 'form' }>;
type DetailSchema = Extract<ComponentSchema, { type: 'detail' }>;
type ActionGroupSchema = Extract<ComponentSchema, { type: 'action' }>;
type TabsSchema = Extract<ComponentSchema, { type: 'tabs' }>;
type CardSchema = Extract<ComponentSchema, { type: 'card' }>;

/** 页面在生成阶段要用到的全部信息，一次算清避免各函数重复推导 */
interface PageModel {
  page: PageSchema;
  irHash: string;
  searchForm?: SearchFormSchema;
  table?: TableSchema;
  form?: FormSchema;
  detail?: DetailSchema;
  actions?: ActionGroupSchema;
  /** 表格行数据的接口（挂载时调用的那个） */
  listSource?: DataSourceSchema;
  /** 列表是否需要服务端分页 */
  serverPaged: boolean;
  /** 页面内出现的全部接口 */
  sources: DataSourceSchema[];
  /** 表格列上的枚举映射 */
  enumColumns: ColumnSchema[];
}

function firstOf<T extends ComponentSchema['type']>(
  page: PageSchema,
  type: T,
): Extract<ComponentSchema, { type: T }> | undefined {
  return page.components.find((c): c is Extract<ComponentSchema, { type: T }> => c.type === type);
}

export function buildPageModel(page: PageSchema, irHash: string): PageModel {
  const searchForm = firstOf(page, 'searchForm');
  const table = firstOf(page, 'table');
  const form = firstOf(page, 'form');
  const detail = firstOf(page, 'detail');
  const actions = firstOf(page, 'action');
  const serverPaged = table?.pagination.mode === 'server';

  const listOperationId = page.mountApi?.operationId ?? table?.api?.operationId;
  const listSource =
    listOperationId !== undefined ? page.dataSources.find((d) => d.operationId === listOperationId) : undefined;

  return {
    page,
    irHash,
    ...(searchForm !== undefined ? { searchForm } : {}),
    ...(table !== undefined ? { table } : {}),
    ...(form !== undefined ? { form } : {}),
    ...(detail !== undefined ? { detail } : {}),
    ...(actions !== undefined ? { actions } : {}),
    ...(listSource !== undefined ? { listSource } : {}),
    serverPaged,
    sources: page.dataSources,
    enumColumns: table?.columns.filter((c) => c.enumMap !== undefined) ?? [],
  };
}

/** 接口模块的路径：按路径首段归组，避免每个接口一个文件 */
export function apiModulePath(ds: DataSourceSchema): string {
  const segments = ds.path.split('/').filter((s) => s.length > 0 && !s.startsWith('{'));
  const resource = toCamelCase(segments.join('-') || 'root');
  return `src/api/modules/${resource}.ts`;
}

export function storePathOf(page: PageSchema): string {
  return `src/stores/${toCamelCase(page.componentName)}.ts`;
}

/** 收集所有页面用到的接口，按模块文件归组 */
function groupByModule(pages: PageSchema[]): Map<string, DataSourceSchema[]> {
  const out = new Map<string, DataSourceSchema[]>();
  for (const page of pages) {
    for (const ds of page.dataSources) {
      const path = apiModulePath(ds);
      const list = out.get(path) ?? [];
      if (!list.some((x) => x.operationId === ds.operationId)) list.push(ds);
      out.set(path, list);
    }
  }
  return out;
}

export const vueGenerator: CodeGenerator = {
  id: GENERATOR_ID,
  version: GENERATOR_VERSION,

  plan(ir: IR): FilePlan[] {
    // 静默生成错误的 UI 库代码比报错更糟：用户会拿到一堆 naive-ui 项目里不存在的
    // el-* 组件，然后在「为什么组件不渲染」上耗半天。宁可在生成阶段直接失败。
    if (ir.settings.frontend.ui !== 'element-plus') {
      throw new Error(
        `前端 UI 库「${ir.settings.frontend.ui}」暂不支持：Vue 生成器只实现了 element-plus。` +
          '请把 settings.frontend.ui 改回 element-plus。',
      );
    }

    const { pages } = emitUiSchema(ir, { viewsDir: 'src/views' });
    const plans: FilePlan[] = [];

    plans.push(
      {
        path: 'package.json',
        kind: 'config',
        sourceNodeIds: [],
        overwrite: 'never',
        description: '前端项目依赖（已存在则不覆盖，避免冲掉用户自己加的依赖）',
      },
      {
        path: 'vite.config.ts',
        kind: 'config',
        sourceNodeIds: [],
        overwrite: 'never',
        description: 'Vite 配置，含 /api 代理',
      },
      { path: 'tsconfig.json', kind: 'config', sourceNodeIds: [], overwrite: 'never' },
      { path: 'index.html', kind: 'config', sourceNodeIds: [], overwrite: 'if-generated' },
      {
        path: 'src/main.ts',
        kind: 'config',
        sourceNodeIds: [],
        overwrite: 'if-generated',
        description: '应用入口：挂载 router、pinia、element-plus',
      },
      { path: 'src/App.vue', kind: 'component', sourceNodeIds: [], overwrite: 'if-generated' },
      {
        path: 'src/router/index.ts',
        kind: 'router',
        sourceNodeIds: pages.map((p) => p.id),
        overwrite: 'always',
        description: '路由表：完全由页面节点决定，手改会被覆盖',
      },
      {
        path: 'src/api/client.ts',
        kind: 'client',
        sourceNodeIds: [],
        overwrite: 'if-generated',
        description: 'axios 实例与拦截器（含鉴权注入挂载点）',
      },
      {
        path: 'src/env.d.ts',
        kind: 'config',
        sourceNodeIds: [],
        overwrite: 'if-generated',
        description: 'Vite 环境变量与 .vue 模块的类型声明（缺了 import.meta.env 会报 TS2339）',
      },
      {
        path: 'src/api/types.gen.ts',
        kind: 'type',
        sourceNodeIds: [],
        overwrite: 'always',
        description: '接口入参/出参类型（由 IR 的接口与页面绑定字段推导）',
      },
    );

    for (const page of pages) {
      plans.push({
        path: page.suggestPath,
        kind: 'page',
        sourceNodeIds: [page.id],
        overwrite: 'if-generated',
        description: `页面「${page.title}」`,
      });
      if (page.components.some((c) => c.type === 'table' && c.pagination.mode === 'server')) {
        plans.push({
          path: storePathOf(page),
          kind: 'store',
          sourceNodeIds: [page.id],
          overwrite: 'if-generated',
          description: `页面「${page.title}」的查询条件与分页状态`,
        });
      }
    }

    for (const [path, sources] of groupByModule(pages)) {
      plans.push({
        path,
        kind: 'client',
        sourceNodeIds: sources.map((s) => s.apiNodeId).filter((id) => id.length > 0),
        overwrite: 'always',
        description: `接口函数 ${sources.map((s) => s.operationId).sort().join(' / ')}`,
      });
    }

    const dedup = new Map<string, FilePlan>();
    for (const plan of plans) dedup.set(plan.path, plan);
    return [...dedup.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
  },

  async render(plan: FilePlan, ir: IR, ctx: CompileContext): Promise<RenderedFile> {
    const { pages, enums: uiEnums } = emitUiSchema(ir, { viewsDir: 'src/views' });
    const irHash = computeSchemaHash(ir);
    const base = {
      path: plan.path,
      kind: plan.kind,
      sourceNodeIds: plan.sourceNodeIds,
      overwrite: plan.overwrite,
      regions: [] as RenderedFile['regions'],
    };

    const page = pages.find((p) => p.suggestPath === plan.path);
    if (page !== undefined) {
      return { ...base, language: 'vue', content: renderPageComponent(buildPageModel(page, irHash), ctx) };
    }

    const storePage = pages.find((p) => storePathOf(p) === plan.path);
    if (storePage !== undefined && plan.kind === 'store') {
      return { ...base, language: 'ts', content: renderListStore(buildPageModel(storePage, irHash)) };
    }

    const moduleSources = groupByModule(pages).get(plan.path);
    if (moduleSources !== undefined && plan.path.startsWith('src/api/modules/')) {
      return { ...base, language: 'ts', content: renderApiModule(plan.path, moduleSources, irHash) };
    }

    switch (plan.path) {
      case 'src/router/index.ts':
        return { ...base, language: 'ts', content: renderRouter(pages, irHash) };
      case 'src/api/types.gen.ts':
        return { ...base, language: 'ts', content: renderApiTypes(pages, irHash, uiEnums) };
      case 'src/api/client.ts':
        return { ...base, language: 'ts', content: renderApiClient(irHash) };
      case 'src/main.ts':
        return { ...base, language: 'ts', content: renderMainTs() };
      case 'src/App.vue':
        return { ...base, language: 'vue', content: renderAppVue() };
      case 'index.html':
        return { ...base, language: 'html', content: renderIndexHtml(ctx.projectName) };
      case 'package.json':
        return { ...base, language: 'json', content: renderPackageJson(ctx.projectName) };
      case 'vite.config.ts':
        return { ...base, language: 'ts', content: renderViteConfig() };
      case 'tsconfig.json':
        return { ...base, language: 'json', content: renderTsconfig() };
      case 'src/env.d.ts':
        return { ...base, language: 'ts', content: renderEnvDts(irHash) };
      default:
        break;
    }

    throw new Error(`vueGenerator 无法渲染未知文件：${plan.path}`);
  },
};

// ────────────────────────────── 页面组件 ──────────────────────────────

export function renderPageComponent(model: PageModel, _ctx: CompileContext): string {
  const { page, irHash } = model;
  const w = new Writer();
  w.line(
    `<!-- @dsg:generated file=${page.suggestPath} node=${page.id} ir=${irHash} generator=${GENERATOR_ID}@${GENERATOR_VERSION} -->`,
  );
  w.line('<template>');
  w.line('  <div class="page">');
  // 被 tabs / card 容器引用的组件在容器内部渲染；顶层必须跳过，否则同一个组件会出现两份
  const nested = nestedComponentIds(page.components);
  for (const component of page.components) {
    if (nested.has(component.id)) continue;
    renderTemplate(w, component, model);
  }
  w.line('  </div>');
  w.line('</template>');
  w.blank();
  w.line('<script setup lang="ts">');
  renderScript(w, model);
  w.line('</script>');
  w.blank();
  w.line('<style scoped>');
  w.line('.page {');
  w.line('  padding: 16px;');
  w.line('}');
  w.blank();
  w.line('.search-form {');
  w.line('  margin-bottom: 16px;');
  w.line('}');
  w.blank();
  w.line('.actions {');
  w.line('  margin-bottom: 16px;');
  w.line('  display: flex;');
  w.line('  gap: 8px;');
  w.line('}');
  w.line('</style>');
  return w.toString();
}

/** HTML 模板里的字符串属性一律双引号 */
function attr(value: string): string {
  return `"${value.replace(/"/g, '&quot;')}"`;
}

/** 被容器引用的组件 id（扁平列表里可能存在多层引用，遍历一遍即可全部覆盖） */
function nestedComponentIds(components: ComponentSchema[]): Set<string> {
  const out = new Set<string>();
  for (const component of components) {
    if (component.type === 'tabs') {
      for (const tab of component.tabs) for (const id of tab.componentIds) out.add(id);
    } else if (component.type === 'card') {
      for (const id of component.componentIds) out.add(id);
    }
  }
  return out;
}

/** 受限表达式写进 HTML 属性：双引号必须转义，否则属性会被表达式里的引号截断 */
function exprAttr(value: string): string {
  return `"${value.replace(/"/g, '&quot;')}"`;
}

function renderTemplate(w: Writer, component: ComponentSchema, model: PageModel): void {
  // visibleWhen 是「整体显隐」语义，所以包在外层而不是落到每个控件上：
  // 表单里少一个控件和整块区域不显示，是两回事。
  if (component.visibleWhen !== undefined) {
    w.line(`    <template v-if=${exprAttr(component.visibleWhen)}>`);
    w.indent();
    renderComponentBody(w, component, model);
    w.dedent();
    w.line('    </template>');
    return;
  }
  renderComponentBody(w, component, model);
}

function renderComponentBody(w: Writer, component: ComponentSchema, model: PageModel): void {
  switch (component.type) {
    case 'searchForm':
      renderSearchForm(w, component);
      return;
    case 'table':
      renderTable(w, component, model);
      return;
    case 'form':
      renderForm(w, component);
      return;
    case 'detail':
      renderDetail(w, component);
      return;
    case 'action':
      renderActionGroup(w, component);
      return;
    case 'tabs':
      renderTabs(w, component, model);
      return;
    case 'card':
      renderCard(w, component, model);
      return;
    default:
      return;
  }
}

/** 容器里的子组件：按 id 回查扁平列表，找不到就留一条注释而不是静默丢弃 */
function renderChild(w: Writer, componentId: string, model: PageModel): void {
  const child = model.page.components.find((c) => c.id === componentId);
  if (child === undefined) {
    w.line(`    <!-- 容器引用了不存在的组件 ${componentId} -->`);
    return;
  }
  renderTemplate(w, child, model);
}

function renderTabs(w: Writer, component: TabsSchema, model: PageModel): void {
  w.line('    <el-tabs v-model="activeTab">');
  w.indent();
  for (const tab of component.tabs) {
    w.line(`    <el-tab-pane label=${attr(tab.label)} name=${attr(tab.key)}>`);
    w.indent();
    for (const id of tab.componentIds) renderChild(w, id, model);
    w.dedent();
    w.line('    </el-tab-pane>');
  }
  w.dedent();
  w.line('    </el-tabs>');
}

function renderCard(w: Writer, component: CardSchema, model: PageModel): void {
  w.line(`    <el-card shadow=${attr(component.shadow)}>`);
  if (component.title !== undefined) {
    w.line(`      <template #header>${component.title}</template>`);
  }
  w.indent();
  for (const id of component.componentIds) renderChild(w, id, model);
  w.dedent();
  w.line('    </el-card>');
}

function renderSearchForm(w: Writer, component: SearchFormSchema): void {
  w.line('    <el-form :model="query" inline class="search-form">');
  if (component.fields.length <= INLINE_THRESHOLD) {
    for (const field of component.fields) renderSearchItem(w, field);
  } else {
    w.line('      <!-- 字段数超过阈值，改为循环渲染 -->');
    w.line('      <el-form-item v-for="f in searchFields" :key="f.prop" :label="f.label">');
    w.line('        <el-input v-model="query[f.prop]" />');
    w.line('      </el-form-item>');
  }
  w.line('      <el-form-item>');
  w.line('        <el-button type="primary" @click="handleSearch">查询</el-button>');
  w.line('        <el-button @click="handleReset">重置</el-button>');
  w.line('      </el-form-item>');
  w.line('    </el-form>');
}

function renderSearchItem(w: Writer, field: FieldSchema): void {
  w.line(`      <el-form-item label=${attr(field.label)} prop=${attr(field.prop)}>`);
  switch (field.control) {
    case 'textarea':
      w.line(`        <el-input v-model="query.${field.prop}" type="textarea" />`);
      break;
    case 'number':
      w.line(`        <el-input-number v-model="query.${field.prop}" />`);
      break;
    case 'switch':
      w.line(`        <el-switch v-model="query.${field.prop}" />`);
      break;
    case 'date':
      w.line(`        <el-date-picker v-model="query.${field.prop}" type="date" />`);
      break;
    case 'datetime':
      w.line(`        <el-date-picker v-model="query.${field.prop}" type="datetime" />`);
      break;
    case 'select':
      w.line(`        <el-select v-model="query.${field.prop}" clearable>`);
      for (const value of field.enumValues ?? []) {
        const label = field.enumLabels?.[value] ?? value;
        w.line(`          <el-option label=${attr(label)} value=${attr(value)} />`);
      }
      w.line('        </el-select>');
      break;
    default:
      w.line(`        <el-input v-model="query.${field.prop}" />`);
  }
  w.line('      </el-form-item>');
}

function renderTable(w: Writer, component: TableSchema, model: PageModel): void {
  // row-key 影响选择列的「跨页保持勾选」与展开行；不给的话 el-table 会按索引认行
  const rowKey = component.rowKey !== undefined ? ` row-key=${attr(component.rowKey)}` : '';
  w.line(`    <el-table :data="rows" v-loading="loading" border${rowKey}>`);
  if (component.selection !== 'none') {
    w.line('      <el-table-column type="selection" width="48" />');
  }
  for (const column of component.columns) {
    const attrs = [`prop=${attr(column.prop)}`, `label=${attr(column.label)}`];
    if (column.width !== undefined) attrs.push(`width="${column.width}"`);
    if (column.align !== undefined) attrs.push(`align=${attr(column.align)}`);
    if (column.sortable === true) attrs.push('sortable');
    if (column.ellipsis === true) attrs.push('show-overflow-tooltip');

    if (column.formatter !== undefined) {
      // formatter 是「受限表达式」，不是函数名：写成 el-table-column 的 formatter prop
      // 会变成一个不存在的函数引用，所以改走作用域插槽
      w.line(`      <el-table-column ${attrs.join(' ')}>`);
      w.line('        <template #default="{ row }">');
      w.line(`          {{ ${column.formatter} }}`);
      w.line('        </template>');
      w.line('      </el-table-column>');
    } else if (column.enumMap !== undefined) {
      const entries = Object.entries(column.enumMap)
        .map(([k, v]) => `${k}: ${quote(v)}`)
        .join(', ');
      w.line(`      <el-table-column ${attrs.join(' ')}>`);
      w.line('        <template #default="{ row }">');
      w.line(
        `          <el-tag>{{ ({ ${entries} } as Record<string, string>)[String(row.${column.prop})] ?? row.${column.prop} }}</el-tag>`,
      );
      w.line('        </template>');
      w.line('      </el-table-column>');
    } else {
      w.line(`      <el-table-column ${attrs.join(' ')} />`);
    }
  }
  if (component.rowActions.length > 0) {
    w.line('      <el-table-column label="操作" width="180" fixed="right">');
    w.line('        <template #default="{ row }">');
    for (const action of component.rowActions) {
      w.line(
        `          <el-button link type="primary" @click="handleAction(${attr(action.id)}, row)">${action.label}</el-button>`,
      );
    }
    w.line('        </template>');
    w.line('      </el-table-column>');
  }
  w.line('    </el-table>');

  if (model.serverPaged) {
    w.blank();
    w.line('    <el-pagination');
    w.line('      :current-page="pagination.page"');
    w.line('      :page-size="pagination.pageSize"');
    w.line('      :total="pagination.total"');
    w.line('      layout="total, sizes, prev, pager, next"');
    w.line('      @current-change="handlePageChange"');
    w.line('      @size-change="handleSizeChange"');
    w.line('    />');
  }
}

function renderForm(w: Writer, component: FormSchema): void {
  w.line('    <el-form ref="formRef" :model="form" :rules="rules" label-width="120px">');
  for (const field of component.fields) {
    // 只读字段渲染成 disabled 而不是直接删掉：编辑页里 createdAt 这类值需要看得见
    const dis = field.readOnly === true ? ' disabled' : '';
    w.line(`      <el-form-item label=${attr(field.label)} prop=${attr(field.prop)}>`);
    switch (field.control) {
      case 'textarea':
        w.line(`        <el-input v-model="form.${field.prop}" type="textarea"${dis} />`);
        break;
      case 'number':
        w.line(`        <el-input-number v-model="form.${field.prop}"${dis} />`);
        break;
      case 'switch':
        w.line(`        <el-switch v-model="form.${field.prop}"${dis} />`);
        break;
      case 'date':
        w.line(`        <el-date-picker v-model="form.${field.prop}" type="date"${dis} />`);
        break;
      case 'datetime':
        w.line(`        <el-date-picker v-model="form.${field.prop}" type="datetime"${dis} />`);
        break;
      case 'select':
        w.line(`        <el-select v-model="form.${field.prop}"${dis}>`);
        for (const value of field.enumValues ?? []) {
          const label = field.enumLabels?.[value] ?? value;
          w.line(`          <el-option label=${attr(label)} value=${attr(value)} />`);
        }
        w.line('        </el-select>');
        break;
      case 'upload':
        w.line(`        <el-upload v-model:file-list="uploadFiles.${field.prop}"${dis} />`);
        break;
      default:
        w.line(`        <el-input v-model="form.${field.prop}"${dis} />`);
    }
    w.line('      </el-form-item>');
  }
  w.line('      <el-form-item>');
  w.line(`        <el-button type="primary" @click="handleSubmit">${component.submitText}</el-button>`);
  w.line('      </el-form-item>');
  w.line('    </el-form>');
}

function renderDetail(w: Writer, component: DetailSchema): void {
  w.line(`    <el-descriptions :column="${component.columns}" border>`);
  for (const field of component.fields) {
    w.line(`      <el-descriptions-item label=${attr(field.label)}>{{ detail.${field.prop} }}</el-descriptions-item>`);
  }
  w.line('    </el-descriptions>');
}

function renderActionGroup(w: Writer, component: ActionGroupSchema): void {
  w.line('    <div class="actions">');
  for (const action of component.actions) {
    const type = action.level !== undefined && action.level !== 'default' ? ` type="${action.level}"` : '';
    w.line(`      <el-button${type} @click="handleAction(${attr(action.id)}, null)">${action.label}</el-button>`);
  }
  w.line('    </div>');
}

// ────────────────────────────── script ──────────────────────────────

function renderScript(w: Writer, model: PageModel): void {
  const { page, listSource, searchForm, form, detail, table, serverPaged } = model;

  const tabsComponents = page.components.filter((c): c is TabsSchema => c.type === 'tabs');
  const allActions: ActionSchema[] = [...(model.actions?.actions ?? []), ...(table?.rowActions ?? [])];

  // ── imports：只导入真正用到的，避免生成一堆 eslint 会报未使用的符号 ──
  // 注意 `reactive` 的条件不能简单写成「有搜索表单」：服务端分页时 query 来自
  // store，组件里根本没有 reactive(...) 调用，import 了就是一条未使用的导入。
  const usesReactive =
    form !== undefined || detail !== undefined || (searchForm !== undefined && !serverPaged);
  const vueImports = new Set<string>(['onMounted']);
  if (usesReactive) vueImports.add('reactive');
  if (table !== undefined || form !== undefined || tabsComponents.length > 0) vueImports.add('ref');
  w.line(`import { ${[...vueImports].sort().join(', ')} } from 'vue';`);
  if (allActions.some((a) => a.confirm !== undefined)) {
    w.line("import { ElMessageBox } from 'element-plus';");
  }

  const importedByModule = new Map<string, string[]>();
  for (const ds of model.sources) {
    const mod = apiModulePath(ds).replace(/^src\//, '@/').replace(/\.ts$/, '');
    const list = importedByModule.get(mod) ?? [];
    list.push(ds.operationId);
    importedByModule.set(mod, list);
  }
  for (const [mod, names] of [...importedByModule.entries()].sort()) {
    w.line(`import { ${[...names].sort().join(', ')} } from '${mod}';`);
  }
  if (serverPaged) {
    w.line(`import { use${page.componentName}Store } from '@/stores/${toCamelCase(page.componentName)}';`);
  }

  const types = new Set<string>();
  for (const ds of model.sources) {
    types.add(`${toPascalCase(ds.operationId)}Params`);
    if (ds.responseShape !== 'raw') types.add(responseTypeName(ds));
  }
  // 枚举别名（如 DeviceStatus）也要导入：query/form 的类型标注会引用它
  const typedFields = [...(searchForm?.fields ?? []), ...(form?.fields ?? []), ...(detail?.fields ?? [])];
  for (const name of referencedTypeNames(typedFields)) types.add(name);
  if (types.size > 0) w.line(`import type { ${[...types].sort().join(', ')} } from '@/api/types.gen';`);
  w.blank();

  // ── 容器状态 ──
  if (tabsComponents.length > 0) {
    // 默认停在第一个 tab。IR 里给了 activeKey 就用它，否则用第一个页签的 key
    const first = tabsComponents[0]!;
    const initial = first.activeKey ?? first.tabs[0]?.key ?? '';
    w.line(`const activeTab = ref(${quote(initial)});`);
    w.blank();
  }

  // ── 查询条件与分页：分页时放 store 共享，不翻页时留在组件内 ──
  if (serverPaged) {
    w.line(`const store = use${page.componentName}Store();`);
    w.line('const { pagination, query } = store;');
    w.blank();
  } else if (searchForm !== undefined) {
    // 类型写成内联对象字面量而不是另起一个接口：
    // 它只在「不分页、query 留在组件内」时用一次，抽成接口只会多一处要同步的地方
    if (searchForm.fields.length === 0) {
      w.line('const query = reactive<Record<string, string | number | boolean | undefined>>({});');
    } else {
      w.line('const query = reactive<{');
      for (const line of queryTypeLines(searchForm.fields, '  ')) w.line(line);
      w.line('}>({');
      for (const field of searchForm.fields) w.line(`  ${field.prop}: ${defaultLiteralFor(field)},`);
      w.line('});');
    }
    w.blank();
  }

  // ── 搜索表单的运行时描述（仅在字段过多、改为循环渲染时需要） ──
  if (searchForm !== undefined && searchForm.fields.length > INLINE_THRESHOLD) {
    w.line('const searchFields = [');
    for (const field of searchForm.fields) {
      w.line(`  { prop: ${quote(field.prop)}, label: ${quote(field.label)} },`);
    }
    w.line('];');
    w.blank();
  }

  // ── 表格数据 ──
  if (table !== undefined) {
    if (listSource !== undefined && listSource.responseShape === 'list') {
      w.line(`const rows = ref<${responseTypeName(listSource)}[]>([]);`);
    } else {
      w.line('const rows = ref<Record<string, unknown>[]>([]);');
    }
    w.line('const loading = ref(false);');
    w.blank();
  }

  // ── 表单 ──
  if (form !== undefined) {
    w.line('const formRef = ref();');
    if (form.fields.length === 0) {
      w.line('const form = reactive<Record<string, string | number | boolean | undefined>>({});');
    } else {
      w.line('const form = reactive<{');
      for (const line of queryTypeLines(form.fields, '  ')) w.line(line);
      w.line('}>({');
      for (const field of form.fields) w.line(`  ${field.prop}: ${defaultLiteralFor(field)},`);
      w.line('});');
    }
    w.blank();
    w.line('const rules = {');
    for (const field of form.fields) {
      if (field.rules.length === 0) continue;
      w.line(`  ${field.prop}: [`);
      for (const rule of field.rules) {
        const parts = [`type: '${rule.kind}'`];
        if (rule.value !== undefined) parts.push(`value: ${JSON.stringify(rule.value)}`);
        parts.push(`message: ${quote(rule.message)}`);
        if (rule.trigger !== undefined) parts.push(`trigger: '${rule.trigger}'`);
        w.line(`    { ${parts.join(', ')} },`);
      }
      w.line('  ],');
    }
    w.line('};');
    w.blank();
    if (form.fields.some((f) => f.control === 'upload')) {
      w.line('const uploadFiles = reactive<Record<string, unknown[]>>({});');
      w.blank();
    }
  }

  // 编辑模式的回显：只有声明了 loadApi 才生成，否则在 onMounted 里留一条 todo
  if (form !== undefined && form.loadApi !== undefined) {
    const ds = model.sources.find((d) => d.operationId === form.loadApi?.operationId);
    if (ds !== undefined) {
      const paramsType = `${toPascalCase(ds.operationId)}Params`;
      w.line('async function loadForm(id: string) {');
      w.line(`  const res = await ${ds.operationId}({ id } as ${paramsType});`);
      w.line('  Object.assign(form, res);');
      w.line('}');
      w.blank();
    }
  }

  if (detail !== undefined) {
    w.line('const detail = reactive<Record<string, unknown>>({});');
    w.blank();
  }

  // ── 数据加载：先声明，后面 handleSearch 等会引用 ──
  if (table !== undefined) {
    if (listSource !== undefined) {
      renderLoadData(w, listSource, searchForm, serverPaged);
    } else {
      w.line('async function loadData() {');
      w.line('  // @dsg:todo 本页表格没有绑定接口，数据来源需手动补');
      w.line('}');
      w.blank();
    }
  }

  if (detail !== undefined && detail.api !== undefined) {
    const ds = model.sources.find((d) => d.operationId === detail.api!.operationId);
    if (ds !== undefined) {
      const paramsType = `${toPascalCase(ds.operationId)}Params`;
      w.line('async function loadDetail(id: string) {');
      w.line(`  const res = await ${ds.operationId}({ id } as ${paramsType});`);
      w.line('  Object.assign(detail, res);');
      w.line('}');
      w.blank();
    }
  }

  // ── 交互 ──
  if (searchForm !== undefined) {
    w.line('function handleSearch() {');
    if (serverPaged) w.line('  pagination.page = 1;');
    w.line('  void loadData();');
    w.line('}');
    w.blank();
    w.line('function handleReset() {');
    if (serverPaged) w.line('  store.resetQuery();');
    else {
      for (const field of searchForm.fields) w.line(`  query.${field.prop} = ${defaultLiteralFor(field)};`);
    }
    w.line('  void loadData();');
    w.line('}');
    w.blank();
  }

  if (serverPaged) {
    w.line('function handlePageChange(page: number) {');
    w.line('  pagination.page = page;');
    w.line('  void loadData();');
    w.line('}');
    w.blank();
    w.line('function handleSizeChange(size: number) {');
    w.line('  pagination.pageSize = size;');
    w.line('  pagination.page = 1;');
    w.line('  void loadData();');
    w.line('}');
    w.blank();
  }

  if (form !== undefined) {
    w.line('async function handleSubmit() {');
    w.line('  await formRef.value?.validate();');
    const submitSource =
      form.api !== undefined ? model.sources.find((d) => d.operationId === form.api!.operationId) : undefined;
    if (submitSource !== undefined) {
      const paramsType = `${toPascalCase(submitSource.operationId)}Params`;
      w.line(`  await ${submitSource.operationId}(form as unknown as ${paramsType});`);
      w.line('  // @dsg:todo 提交成功后的跳转或列表刷新');
    } else {
      w.line('  // @dsg:todo 表单未绑定提交接口');
    }
    w.line('}');
    w.blank();
  }

  if (allActions.length > 0) {
    w.line('async function handleAction(id: string, row: Record<string, unknown> | null) {');
    w.line('  switch (id) {');
    for (const action of allActions) {
      w.line(`    case ${quote(action.id)}: {`);
      // 二次确认必须放在调用接口之前，否则用户点了「取消」但数据已经删了
      if (action.confirm !== undefined) {
        w.line(`      await ElMessageBox.confirm(${quote(action.confirm)}, '请确认', { type: 'warning' });`);
      }
      if (action.api !== undefined) {
        const paramsType = `${toPascalCase(action.api.operationId)}Params`;
        if (action.navigateTo !== undefined) {
          w.line(`      // @dsg:todo 调用成功后跳转到 ${action.navigateTo}`);
        }
        w.line(`      await ${action.api.operationId}((row ?? {}) as unknown as ${paramsType});`);
      } else if (action.navigateTo !== undefined) {
        w.line(`      // @dsg:todo 跳转到 ${action.navigateTo}`);
      } else {
        w.line('      // @dsg:todo 该动作没有绑定接口');
      }
      w.line('      break;');
      w.line('    }');
    }
    w.line('    default:');
    w.line('      break;');
    w.line('  }');
    w.line('}');
    w.blank();
  }

  // ── 生命周期 ──
  w.line('onMounted(() => {');
  if (table !== undefined) w.line('  void loadData();');
  if (detail !== undefined && detail.api !== undefined) {
    w.line('  // @dsg:todo 从路由参数取 id 后调用 loadDetail(id)');
  }
  if (form?.loadApi !== undefined) {
    w.line('  // @dsg:todo 从路由参数取 id 后调用 loadForm(id)');
  }
  w.line('});');
}

/**
 * 生成 loadData。
 *
 * 分页参数的拼装最容易出错：page/pageSize 在 store 里，筛选条件在 query 里，
 * 两者拼装必须与后端契约一致（page/pageSize，不是 current/size）。
 * 这里显式展开成对象字面量，用户一眼能看出请求长什么样。
 */
function renderLoadData(
  w: Writer,
  ds: DataSourceSchema,
  searchForm: SearchFormSchema | undefined,
  serverPaged: boolean,
): void {
  const paramsType = `${toPascalCase(ds.operationId)}Params`;
  w.line('async function loadData() {');
  w.line('  loading.value = true;');
  w.line('  try {');
  w.line('    const params = {');
  if (serverPaged) {
    w.line('      page: pagination.page,');
    w.line('      pageSize: pagination.pageSize,');
  }
  for (const field of searchForm?.fields ?? []) {
    w.line(`      ${field.prop}: query.${field.prop},`);
  }
  w.line(`    } as ${paramsType};`);
  w.line(`    const res = await ${ds.operationId}(params);`);
  if (ds.responseShape === 'list') {
    const dataKey = ds.dataKey ?? 'items';
    w.line(`    rows.value = res.${dataKey} as ${responseTypeName(ds)}[];`);
    if (serverPaged && ds.totalKey !== undefined) w.line(`    pagination.total = res.${ds.totalKey};`);
    else if (serverPaged) w.line('    pagination.total = rows.value.length;');
  } else if (ds.responseShape === 'object') {
    w.line(`    rows.value = [res as ${responseTypeName(ds)}];`);
  } else {
    w.line('    // @dsg:todo 响应不是结构化数据，交给调用方处理');
  }
  w.line('  } finally {');
  w.line('    loading.value = false;');
  w.line('  }');
  w.line('}');
  w.blank();
}

/** 响应类型的名字：列表取 `<Op>Item`，对象取 `<Op>Response` */
function responseTypeName(ds: DataSourceSchema): string {
  const base = toPascalCase(ds.operationId);
  return ds.responseShape === 'list' ? `${base}Item` : `${base}Response`;
}

/**
 * 查询条件对象的类型声明。
 *
 * 为什么不写成 `Record<string, unknown>`：Element Plus 的 `v-model` 对
 * `unknown` 一律报 TS2322（unknown 不能赋给 string）。用户拿到的会是一个
 * 一打开就满屏红色波浪线的「生成成功」项目——而那时他已经在另一个仓库里，
 * 根本联想不到是这里的类型没带出来。
 */
function queryTypeLines(fields: FieldSchema[], indent: string): string[] {
  return fields.map((f) => `${indent}${f.prop}?: ${f.tsType};`);
}

/** 字段里引用到的非原始类型名（枚举别名），需要从 types.gen.ts 导入 */
function referencedTypeNames(fields: FieldSchema[]): string[] {
  const PRIMITIVE = new Set(['string', 'number', 'boolean', 'unknown', 'null', 'undefined']);
  const out = new Set<string>();
  for (const f of fields) {
    const bare = f.tsType.replace(/\[\]$/, '');
    if (!PRIMITIVE.has(bare)) out.add(bare);
  }
  return [...out].sort();
}

function defaultLiteralFor(field: FieldSchema): string {
  if (field.type === 'boolean') return 'false';
  if (field.enumValues !== undefined && field.enumValues.length > 0) {
    const first = field.enumValues[0];
    if (first !== undefined) return quote(first);
  }
  return 'undefined';
}

// ────────────────────────────── store ──────────────────────────────

export function renderListStore(model: PageModel): string {
  const { page, irHash, searchForm } = model;
  const w = new Writer();
  const name = `use${page.componentName}Store`;

  w.line(
    `// @dsg:generated file=${storePathOf(page)} node=${page.id} ir=${irHash} generator=${GENERATOR_ID}@${GENERATOR_VERSION}`,
  );
  w.line("import { defineStore } from 'pinia';");
  w.line("import { reactive } from 'vue';");
  // 查询条件的类型里可能引用枚举别名（如 DeviceStatus），必须一起导入
  const enumTypeNames = referencedTypeNames(searchForm?.fields ?? []);
  if (enumTypeNames.length > 0) w.line(`import type { ${enumTypeNames.join(', ')} } from '@/api/types.gen';`);
  w.blank();
  w.line('/**');
  w.line(' * 列表页的查询条件与分页状态。');
  w.line(' * 放 store 而不是组件内 ref 的原因：搜索表单、表格、工具栏是三个同级组件，');
  w.line(' * 各自持有一份 query 会导致「点了查询但表格用的还是旧条件」这类问题。');
  w.line(' */');
  const fields = searchForm?.fields ?? [];

  // query 的类型必须先落成别名再复用：直接内联写在 reactive<...> 上，
  // initialQuery 里的 'ACTIVE' 会被推断成 string（字面量拓宽），
  // 于是 `Object.assign` 和 `{...initialQuery}` 两处都报 TS2345——
  // 明明枚举值来自同一个字典，TS 却认为它俩不是同一个类型。
  if (fields.length > 0) {
    w.line('type Query = {');
    for (const line of queryTypeLines(fields, '  ')) w.line(line);
    w.line('};');
    w.blank();
  }

  w.line(`export const ${name} = defineStore(${quote(toCamelCase(page.componentName))}, () => {`);
  if (fields.length > 0) {
    w.line('  const initialQuery: Query = {');
  } else {
    w.line('  const initialQuery: Record<string, string | number | boolean | undefined> = {');
  }
  for (const field of fields) {
    w.line(`    ${field.prop}: ${defaultLiteralFor(field)},`);
  }
  w.line('  };');
  w.blank();
  w.line(`  const query = reactive<${fields.length > 0 ? 'Query' : 'Record<string, string | number | boolean | undefined>'}>({ ...initialQuery });`);
  w.line('  const pagination = reactive({ page: 1, pageSize: 20, total: 0 });');
  w.blank();
  w.line('  function resetQuery() {');
  w.line('    Object.assign(query, initialQuery);');
  w.line('    pagination.page = 1;');
  w.line('  }');
  w.blank();
  w.line('  return { query, pagination, resetQuery };');
  w.line('});');
  return w.toString();
}

// ────────────────────────────── router / 类型 / client ──────────────────────────────

export function renderRouter(pages: PageSchema[], irHash: string): string {
  const w = new Writer();
  w.line(`// @dsg:generated file=src/router/index.ts ir=${irHash} generator=${GENERATOR_ID}@${GENERATOR_VERSION}`);
  w.line("import { createRouter, createWebHistory } from 'vue-router';");
  w.blank();
  w.line('const routes = [');
  for (const page of pages) {
    w.line('  {');
    w.line(`    path: ${quote(page.route)},`);
    w.line(`    name: ${quote(page.componentName)},`);
    w.line(`    component: () => import('@/${page.suggestPath.replace(/^src\//, '')}'),`);
    w.line(`    meta: { title: ${quote(page.title)} },`);
    w.line('  },');
  }
  w.line('];');
  w.blank();
  w.line('export const router = createRouter({');
  w.line('  history: createWebHistory(import.meta.env.BASE_URL),');
  w.line('  routes,');
  w.line('});');
  w.blank();
  w.line('router.afterEach((to) => {');
  w.line('  const title = to.meta.title;');
  w.line("  if (typeof title === 'string') document.title = title;");
  w.line('});');
  w.blank();
  w.line('export default router;');
  return w.toString();
}

export function renderApiTypes(pages: PageSchema[], irHash: string, enums: EnumTypeSchema[] = []): string {
  const w = new Writer();
  w.line(`// @dsg:generated file=src/api/types.gen.ts ir=${irHash} generator=${GENERATOR_ID}@${GENERATOR_VERSION}`);
  w.line('// 由 IR 的接口与页面绑定字段推导。需要与 OpenAPI 严格一致的版本请用');
  w.line('// openapi-typescript 从 fsdt 产出的 openapi.yaml 重新生成。');
  w.blank();

  // 枚举先声明：文件里后面的接口会引用这些名字，TS 里 type 可以先使用后声明，
  // 但把「类型定义」放在最前面，读起来更接近契约文件，diff 也更稳定。
  for (const def of enums) {
    if (def.values.length === 0) {
      w.line(`export type ${def.name} = string;`);
    } else {
      w.line(`export type ${def.name} =`);
      def.values.forEach((v, i) => {
        w.line(`  | ${quote(v.value)}${i === def.values.length - 1 ? ';' : ''}`);
      });
    }
    w.blank();
  }

  const seen = new Set<string>();
  for (const page of pages) {
    for (const ds of page.dataSources) {
      if (seen.has(ds.operationId)) continue;
      seen.add(ds.operationId);
      const base = toPascalCase(ds.operationId);

      // 请求参数：查询条件 + 路径参数 + 提交体都用它
      w.line(`export interface ${base}Params {`);
      for (const field of ds.requestFields) w.line(`  ${field.prop}?: ${field.tsType};`);
      w.line('  [key: string]: unknown;');
      w.line('}');
      w.blank();

      if (ds.responseShape === 'list') {
        w.line(`export interface ${base}Item {`);
        for (const field of ds.responseFields) w.line(`  ${field.prop}?: ${field.tsType};`);
        w.line('  [key: string]: unknown;');
        w.line('}');
        w.blank();
        w.line(`export interface ${base}Response {`);
        w.line(`  ${ds.dataKey ?? 'items'}: ${base}Item[];`);
        if (ds.totalKey !== undefined) w.line(`  ${ds.totalKey}: number;`);
        w.line('}');
      } else if (ds.responseShape === 'object') {
        w.line(`export interface ${base}Response {`);
        for (const field of ds.responseFields) w.line(`  ${field.prop}?: ${field.tsType};`);
        w.line('  [key: string]: unknown;');
        w.line('}');
      } else {
        w.line(`export type ${base}Response = unknown;`);
      }
      w.blank();
    }
  }

  return w.toString();
}

export function renderApiClient(irHash: string): string {
  const w = new Writer();
  w.line(`// @dsg:generated file=src/api/client.ts ir=${irHash} generator=${GENERATOR_ID}@${GENERATOR_VERSION}`);
  w.line("import axios from 'axios';");
  w.line("import { ElMessage } from 'element-plus';");
  w.blank();
  w.line('export const client = axios.create({');
  w.line("  baseURL: import.meta.env.VITE_API_BASE_URL ?? '/api',");
  w.line('  timeout: 15000,');
  w.line('});');
  w.blank();
  w.line('client.interceptors.request.use((config) => {');
  w.line('  // @dsg:todo 注入鉴权信息（本工具不生成认证骨架）');
  w.line('  // 若使用公司 SSO / 网关鉴权，在这里换取 token 并写入 header：');
  w.line('  // const token = useAuthStore().token;');
  w.line('  // if (token) config.headers.Authorization = `Bearer ${token}`;');
  w.line('  return config;');
  w.line('});');
  w.blank();
  w.line('client.interceptors.response.use(');
  w.line('  (response) => response,');
  w.line('  (error) => {');
  w.line('    const status = error.response?.status;');
  w.line('    const message = error.response?.data?.message ?? error.message ?? "请求失败";');
  w.line('    if (status === 401) {');
  w.line('      // @dsg:todo 401 处理：跳登录页或触发刷新 token');
  w.line('    }');
  w.line('    ElMessage.error(String(message));');
  w.line('    return Promise.reject(error);');
  w.line('  },');
  w.line(');');
  return w.toString();
}

/**
 * 一个模块文件可能承载多个接口（同一路径段的不同方法），
 * 所以这里收的是数组而不是单个 DataSource。
 */
export function renderApiModule(path: string, sources: DataSourceSchema[], irHash: string): string {
  const w = new Writer();
  const nodeIds = sources.map((s) => s.apiNodeId).filter((id) => id.length > 0);
  w.line(
    `// @dsg:generated file=${path} node=${nodeIds.length > 0 ? nodeIds.join(',') : '-'} ir=${irHash} generator=${GENERATOR_ID}@${GENERATOR_VERSION}`,
  );
  w.line("import { client } from '@/api/client';");

  const typeNames = new Set<string>();
  for (const ds of sources) {
    typeNames.add(`${toPascalCase(ds.operationId)}Params`);
    typeNames.add(`${toPascalCase(ds.operationId)}Response`);
  }
  w.line(`import type { ${[...typeNames].sort().join(', ')} } from '@/api/types.gen';`);
  w.blank();

  const sorted = [...sources].sort((a, b) => (a.operationId < b.operationId ? -1 : 1));
  for (const ds of sorted) {
    const base = toPascalCase(ds.operationId);
    w.line(`/** ${ds.method} ${ds.path} */`);
    w.line(`export async function ${ds.operationId}(params?: ${base}Params): Promise<${base}Response> {`);
    w.line(`  const response = await client.request<${base}Response>({`);
    w.line(`    method: '${ds.method}',`);
    w.line(`    url: ${quote(ds.path)},`);
    if (['GET', 'DELETE', 'HEAD'].includes(ds.method)) w.line('    params,');
    else w.line('    data: params,');
    w.line('  });');
    w.line('  return response.data;');
    w.line('}');
    w.blank();
  }

  return w.toString();
}

// ────────────────────────────── 工程骨架 ──────────────────────────────

function renderMainTs(): string {
  const w = new Writer();
  w.line("import { createApp } from 'vue';");
  w.line("import ElementPlus from 'element-plus';");
  w.line("import zhCn from 'element-plus/es/locale/lang/zh-cn';");
  w.line("import { createPinia } from 'pinia';");
  w.line("import 'element-plus/dist/index.css';");
  w.blank();
  w.line("import App from './App.vue';");
  w.line("import router from './router';");
  w.blank();
  w.line('const app = createApp(App);');
  w.line('app.use(createPinia());');
  w.line('app.use(router);');
  w.line('app.use(ElementPlus, { locale: zhCn });');
  w.blank();
  w.line('// @dsg:todo 全局错误处理、权限指令等在此挂载');
  w.blank();
  w.line("app.mount('#app');");
  return w.toString();
}

function renderAppVue(): string {
  const w = new Writer();
  w.line('<template>');
  w.line('  <router-view />');
  w.line('</template>');
  w.blank();
  w.line('<script setup lang="ts">');
  w.line('</script>');
  return w.toString();
}

function renderIndexHtml(projectName: string): string {
  const w = new Writer();
  w.line('<!doctype html>');
  w.line('<html lang="zh-CN">');
  w.line('  <head>');
  w.line('    <meta charset="UTF-8" />');
  w.line('    <meta name="viewport" content="width=device-width, initial-scale=1.0" />');
  w.line(`    <title>${projectName}</title>`);
  w.line('  </head>');
  w.line('  <body>');
  w.line('    <div id="app"></div>');
  w.line('    <script type="module" src="/src/main.ts"></script>');
  w.line('  </body>');
  w.line('</html>');
  return w.toString();
}

function renderPackageJson(projectName: string): string {
  const pkg = {
    // 必须走 toPackageName：中文项目名直接当包名会让 pnpm install 失败
    name: toPackageName(projectName, 'fsdt-frontend'),
    private: true,
    type: 'module',
    scripts: {
      dev: 'vite',
      build: 'vue-tsc -b && vite build',
      preview: 'vite preview',
    },
    dependencies: {
      axios: '^1.13.1',
      'element-plus': '^2.14.7',
      pinia: '^4.1.0',
      vue: '^3.5.44',
      'vue-router': '^5.4.0',
    },
    devDependencies: {
      '@vitejs/plugin-vue': '^6.0.1',
      '@vue/tsconfig': '^0.9.1',
      typescript: '~5.9.3',
      vite: '^8.3.4',
      'vue-tsc': '^3.3.13',
    },
  };
  return JSON.stringify(pkg, null, 2) + '\n';
}

function renderViteConfig(): string {
  const w = new Writer();
  w.line("import { fileURLToPath, URL } from 'node:url';");
  w.blank();
  w.line("import vue from '@vitejs/plugin-vue';");
  w.line("import { defineConfig } from 'vite';");
  w.blank();
  w.line('export default defineConfig({');
  w.line('  plugins: [vue()],');
  w.line('  resolve: {');
  w.line("    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },");
  w.line('  },');
  w.line('  server: {');
  w.line('    port: 5173,');
  w.line('    proxy: {');
  w.line("      '/api': {");
  w.line("        target: 'http://localhost:3000',");
  w.line('        changeOrigin: true,');
  w.line('      },');
  w.line('    },');
  w.line('  },');
  w.line('});');
  return w.toString();
}

/**
 * `src/env.d.ts`。
 *
 * 两个声明缺一不可：
 * - `/// <reference types="vite/client" />` 提供 `import.meta.env`
 *   （缺了 `import.meta.env.VITE_API_BASE_URL` 直接 TS2339）
 * - `*.vue` 模块声明让 TS 认识 `import X from './x.vue'`
 *   （@vitejs/plugin-vue 在运行时处理它，但 tsc 不知道；vue-tsc 会接管，
 *    然而 `vue-tsc -b` 在部分配置下仍需要它兜底）
 */
function renderEnvDts(irHash: string): string {
  const w = new Writer();
  w.line(`// @dsg:generated file=src/env.d.ts ir=${irHash} generator=${GENERATOR_ID}@${GENERATOR_VERSION}`);
  w.line('/// <reference types="vite/client" />');
  w.blank();
  w.line('declare module \'*.vue\' {');
  w.line('  import type { DefineComponent } from \'vue\';');
  w.line('  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;');
  w.line('  export default component;');
  w.line('}');
  w.blank();
  w.line('interface ImportMetaEnv {');
  w.line('  readonly VITE_API_BASE_URL?: string;');
  w.line('}');
  w.blank();
  w.line('interface ImportMeta {');
  w.line('  readonly env: ImportMetaEnv;');
  w.line('}');
  return w.toString();
}

function renderTsconfig(): string {
  const cfg = {
    extends: '@vue/tsconfig/tsconfig.dom.json',
    compilerOptions: {
      baseUrl: '.',
      paths: { '@/*': ['./src/*'] },
      types: ['element-plus/global'],
    },
    include: ['src/**/*.ts', 'src/**/*.vue'],
  };
  return JSON.stringify(cfg, null, 2) + '\n';
}
