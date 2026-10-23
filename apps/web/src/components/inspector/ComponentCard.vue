<script setup lang="ts">
import { computed } from 'vue';

import type { PageComponent, PageNode, TableColumn } from '@fsdt/core-ir';

import { useProjectStore } from '@/stores/project';

const props = defineProps<{
  page: PageNode;
  component: PageComponent;
  index: number;
}>();

const emit = defineEmits<{ remove: [] }>();

const project = useProjectStore();

const TYPE_LABEL: Record<string, string> = {
  searchForm: '搜索表单',
  table: '表格',
  form: '表单',
  detail: '详情',
  action: '按钮',
  tabs: '标签页',
  card: '卡片',
};

const apis = computed(() => project.nodes.filter((n) => n.kind === 'api'));

const fieldOptions = computed(() => {
  const out: Array<{ label: string; value: string }> = [];
  for (const node of project.nodes) {
    if (node.kind !== 'table') continue;
    for (const field of node.table.fields) {
      out.push({ label: `${node.name}.${field.name}`, value: field.id });
    }
  }
  return out;
});

const boundIds = computed(() => {
  if ('bindings' in props.component) return props.component.bindings.map((b) => b.fieldRef);
  return [];
});

const columnIds = computed(() => {
  if (props.component.type !== 'table') return [];
  return props.component.columns.map((c) => c.fieldRef);
});

const apiRef = computed(() => {
  const c = props.component;
  if ('apiRef' in c && typeof c.apiRef === 'string') return c.apiRef;
  return '';
});

function patch(fn: (component: PageComponent) => void): void {
  project.mutate((draft) => {
    const page = draft.nodes.find((n) => n.id === props.page.id);
    if (page === undefined || page.kind !== 'page') return;
    const component = page.page.components.find((c) => c.id === props.component.id);
    if (component !== undefined) fn(component);
  });
}

function setTitle(value: string): void {
  patch((component) => {
    component.title = value;
  });
}

function setApiRef(value: string): void {
  patch((component) => {
    if ('apiRef' in component) component.apiRef = value;
  });
}

function setBound(ids: string[]): void {
  patch((component) => {
    if (!('bindings' in component)) return;
    component.bindings = ids.map((fieldRef) => ({ fieldRef }));
  });
}

function setColumns(ids: string[]): void {
  patch((component) => {
    if (component.type !== 'table') return;
    const existing = new Map<string, TableColumn>(component.columns.map((c) => [c.fieldRef, c]));
    component.columns = ids.map((fieldRef) => existing.get(fieldRef) ?? { fieldRef });
  });
}

function setSubmitText(value: string): void {
  patch((component) => {
    if (component.type === 'form') component.submitText = value;
  });
}

function setMode(value: string): void {
  patch((component) => {
    if (component.type === 'form') component.mode = value === 'edit' ? 'edit' : 'create';
  });
}

function setNavigateTo(value: string): void {
  patch((component) => {
    if (component.type !== 'action') return;
    if (value.trim().length === 0) delete component.navigateTo;
    else component.navigateTo = value.trim();
  });
}

function setPageSize(size: number): void {
  patch((component) => {
    if (component.type === 'table') component.pagination.pageSize = size;
  });
}
</script>

<template>
  <div class="card">
    <div class="card__head">
      <span class="card__type" :data-type="props.component.type">
        {{ TYPE_LABEL[props.component.type] ?? props.component.type }}
      </span>
      <el-input
        :model-value="props.component.title ?? ''"
        size="small"
        class="card__title"
        placeholder="组件标题"
        @change="setTitle(String($event))"
      />
      <button class="card__del" type="button" title="删除组件" @click="emit('remove')">×</button>
    </div>

    <label v-if="'apiRef' in props.component" class="line">
      <span class="line__label">接口</span>
      <el-select :model-value="apiRef" size="small" class="grow" placeholder="选择接口" @update:model-value="setApiRef(String($event))">
        <el-option v-for="api in apis" :key="api.id" :label="`${api.api.method} ${api.api.path}`" :value="api.id" />
      </el-select>
    </label>

    <label v-if="props.component.type !== 'table' && 'bindings' in props.component" class="line">
      <span class="line__label">字段</span>
      <el-select
        :model-value="boundIds"
        size="small"
        multiple
        collapse-tags
        collapse-tags-tooltip
        class="grow"
        placeholder="选择要渲染的字段"
        @update:model-value="setBound($event as string[])"
      >
        <el-option v-for="option in fieldOptions" :key="option.value" :label="option.label" :value="option.value" />
      </el-select>
    </label>

    <template v-if="props.component.type === 'table'">
      <label class="line">
        <span class="line__label">列</span>
        <el-select
          :model-value="columnIds"
          size="small"
          multiple
          collapse-tags
          collapse-tags-tooltip
          class="grow"
          placeholder="选择表格列"
          @update:model-value="setColumns($event as string[])"
        >
          <el-option v-for="option in fieldOptions" :key="option.value" :label="option.label" :value="option.value" />
        </el-select>
      </label>
      <div class="line">
        <span class="line__label">每页</span>
        <el-input-number
          :model-value="props.component.pagination.pageSize"
          :min="1"
          :max="200"
          size="small"
          controls-position="right"
          @update:model-value="setPageSize(Number($event))"
        />
      </div>
    </template>

    <template v-if="props.component.type === 'form'">
      <div class="line">
        <span class="line__label">模式</span>
        <el-select :model-value="props.component.mode" size="small" @update:model-value="setMode(String($event))">
          <el-option label="新建" value="create" />
          <el-option label="编辑" value="edit" />
        </el-select>
        <el-input
          :model-value="props.component.submitText"
          size="small"
          class="grow"
          placeholder="提交按钮文案"
          @change="setSubmitText(String($event))"
        />
      </div>
    </template>

    <template v-if="props.component.type === 'action'">
      <label class="line">
        <span class="line__label">跳转</span>
        <el-input
          :model-value="props.component.navigateTo ?? ''"
          size="small"
          class="grow"
          placeholder="/devices/create"
          @change="setNavigateTo(String($event))"
        />
      </label>
    </template>
  </div>
</template>

<style scoped>
.card {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  background: #fcfcfd;
}

.card__head {
  display: flex;
  align-items: center;
  gap: 6px;
}

.card__type {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 3px;
  background: #eef2ff;
  color: #4f46e5;
  flex-shrink: 0;
}

.card__type[data-type='table'] {
  background: #e0f2fe;
  color: #0369a1;
}

.card__type[data-type='action'] {
  background: #fef3c7;
  color: #b45309;
}

.card__title {
  flex: 1;
  min-width: 0;
}

.card__title :deep(.el-input__wrapper) {
  box-shadow: none;
  background: transparent;
}

.card__del {
  width: 20px;
  height: 20px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  border-radius: 4px;
  font-size: 14px;
  line-height: 1;
  flex-shrink: 0;
}

.card__del:hover {
  background: #fef2f2;
  color: #ef4444;
}

.line {
  display: flex;
  align-items: center;
  gap: 6px;
}

.line__label {
  width: 32px;
  flex-shrink: 0;
  font-size: 10.5px;
  color: var(--text-muted);
}

.grow {
  flex: 1;
  min-width: 0;
}
</style>
