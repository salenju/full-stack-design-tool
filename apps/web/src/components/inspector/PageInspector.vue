<script setup lang="ts">
import { computed } from 'vue';

import { createAction, createForm, createSearchForm, createTable, newComponentId } from '@fsdt/core-ir';
import type { PageComponent, PageLayout, PageNode } from '@fsdt/core-ir';

import ComponentCard from './ComponentCard.vue';
import { useProjectStore } from '@/stores/project';
import { useUiStore } from '@/stores/ui';

const props = defineProps<{ node: PageNode }>();

const project = useProjectStore();
const ui = useUiStore();

const LAYOUTS: Array<{ value: PageLayout; label: string }> = [
  { value: 'list', label: '列表页' },
  { value: 'form', label: '表单页' },
  { value: 'detail', label: '详情页' },
  { value: 'dashboard', label: '看板' },
  { value: 'blank', label: '空白' },
];

const components = computed(() => props.node.page.components);
const firstApi = computed(() => project.nodes.find((n) => n.kind === 'api')?.id ?? '');

function patch(fn: (node: PageNode) => void): void {
  project.mutate((draft) => {
    const target = draft.nodes.find((n) => n.id === props.node.id);
    if (target !== undefined && target.kind === 'page') fn(target);
  });
}

function setRoute(value: string): void {
  const route = value.trim();
  if (route.length === 0) return;
  patch((node) => {
    node.page.route = route.startsWith('/') ? route : `/${route}`;
  });
}

function setTitle(value: string): void {
  const title = value.trim();
  if (title.length === 0) return;
  patch((node) => {
    node.page.title = title;
  });
}

function setLayout(layout: PageLayout): void {
  patch((node) => {
    node.page.layout = layout;
  });
}

function addComponent(type: 'searchForm' | 'table' | 'form' | 'detail' | 'action'): void {
  patch((node) => {
    const api = firstApi.value;
    const created: PageComponent =
      type === 'searchForm'
        ? createSearchForm(api, [], { title: '筛选' })
        : type === 'table'
          ? createTable(api, [], { title: '列表' })
          : type === 'form'
            ? createForm(api, [], { title: '表单', submitText: '保存' })
            : type === 'detail'
              ? { id: newComponentId(), type: 'detail', bindings: [], apiRef: api, columns: 2, title: '详情' }
              : createAction({ title: '操作' });
    node.page.components.push(created);
  });
  ui.notify('success', '已添加组件');
}

function removeComponent(id: string): void {
  patch((node) => {
    node.page.components = node.page.components.filter((c) => c.id !== id);
  });
}
</script>

<template>
  <div class="inspector-body">
    <section class="block">
      <div class="block__title">页面</div>
      <label class="row">
        <span class="row__label">标题</span>
        <el-input :model-value="props.node.page.title" size="small" @change="setTitle(String($event))" />
      </label>
      <label class="row">
        <span class="row__label">路由</span>
        <el-input :model-value="props.node.page.route" size="small" @change="setRoute(String($event))" />
      </label>
      <div class="row">
        <span class="row__label">布局</span>
        <el-select :model-value="props.node.page.layout" size="small" @update:model-value="setLayout($event)">
          <el-option v-for="item in LAYOUTS" :key="item.value" :label="item.label" :value="item.value" />
        </el-select>
      </div>
      <label class="row">
        <span class="row__label">组件名</span>
        <el-input
          :model-value="props.node.codeName"
          size="small"
          @change="
            patch((node) => {
              node.codeName = String($event);
            })
          "
        />
      </label>
    </section>

    <section class="block">
      <div class="block__title">
        组件
        <span class="block__count">{{ components.length }}</span>
      </div>
      <ComponentCard
        v-for="(component, index) in components"
        :key="component.id"
        :page="props.node"
        :component="component"
        :index="index"
        @remove="removeComponent(component.id)"
      />
      <div v-if="components.length === 0" class="empty">还没有组件。列表页通常是「搜索表单 + 表格」。</div>

      <div class="add">
        <span class="add__label">添加：</span>
        <button type="button" class="add__btn" @click="addComponent('searchForm')">搜索表单</button>
        <button type="button" class="add__btn" @click="addComponent('table')">表格</button>
        <button type="button" class="add__btn" @click="addComponent('form')">表单</button>
        <button type="button" class="add__btn" @click="addComponent('detail')">详情</button>
        <button type="button" class="add__btn" @click="addComponent('action')">按钮</button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.inspector-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.block {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.block__title {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--text-muted);
  display: flex;
  align-items: center;
  gap: 6px;
}

.block__count {
  background: #f2f4f7;
  border-radius: 999px;
  padding: 0 6px;
  font-size: 10px;
  color: var(--text-soft);
}

.row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.row__label {
  width: 40px;
  flex-shrink: 0;
  font-size: 11px;
  color: var(--text-soft);
}

.empty {
  font-size: 11px;
  color: var(--text-muted);
}

.add {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  margin-top: 2px;
}

.add__label {
  font-size: 10.5px;
  color: var(--text-muted);
}

.add__btn {
  border: 1px dashed var(--border-strong);
  background: transparent;
  border-radius: 5px;
  padding: 2px 7px;
  font-size: 10.5px;
  color: var(--text-soft);
  cursor: pointer;
}

.add__btn:hover {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-soft);
}
</style>
