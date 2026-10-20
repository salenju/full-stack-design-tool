<script setup lang="ts">
import { computed } from 'vue';

import type { PageNode } from '@fsdt/core-ir';

import NodeFrame from './NodeFrame.vue';
import type { FlowNodeData } from '@/canvas/mapping';

const props = defineProps<{
  data: FlowNodeData;
  selected?: boolean;
}>();

const node = computed(() => props.data.node as PageNode);
const page = computed(() => node.value.page);

const COMPONENT_LABEL: Record<string, string> = {
  searchForm: '搜索表单',
  table: '表格',
  form: '表单',
  detail: '详情',
  action: '按钮',
  tabs: '标签页',
  card: '卡片',
};

const LAYOUT_LABEL: Record<string, string> = {
  list: '列表页',
  form: '表单页',
  detail: '详情页',
  dashboard: '看板',
  blank: '空白',
};
</script>

<template>
  <NodeFrame
    kind="page"
    :title="page.title"
    :subtitle="page.route"
    :badge="LAYOUT_LABEL[page.layout] ?? page.layout"
    :selected="props.selected"
  >
    <div v-for="component in page.components" :key="component.id" class="row">
      <span class="row__icon" :data-type="component.type" />
      <span class="row__name">{{ component.title ?? COMPONENT_LABEL[component.type] ?? component.type }}</span>
      <span class="row__tag">{{ COMPONENT_LABEL[component.type] ?? component.type }}</span>
    </div>
    <div v-if="page.components.length === 0" class="row row--empty">还没有组件</div>
  </NodeFrame>
</template>

<style scoped>
.row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 1px 12px;
  height: 21px;
  font-size: 11.5px;
}

.row__icon {
  width: 6px;
  height: 6px;
  border-radius: 2px;
  background: #cbd5e1;
  flex-shrink: 0;
}

.row__icon[data-type='table'] {
  background: #0ea5e9;
}

.row__icon[data-type='form'],
.row__icon[data-type='searchForm'] {
  background: #8b5cf6;
}

.row__icon[data-type='action'] {
  background: #f59e0b;
}

.row__icon[data-type='detail'] {
  background: #10b981;
}

.row__name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text);
}

.row__tag {
  font-size: 9.5px;
  color: var(--text-muted);
  background: #f2f4f7;
  border-radius: 3px;
  padding: 0 4px;
}

.row--empty {
  color: var(--text-muted);
  font-size: 10.5px;
  padding-left: 14px;
}
</style>
