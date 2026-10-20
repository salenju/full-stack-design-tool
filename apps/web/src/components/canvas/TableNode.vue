<script setup lang="ts">
import { computed } from 'vue';
import { Position } from '@vue-flow/core';

import type { Field, TableNode } from '@fsdt/core-ir';

import NodeFrame from './NodeFrame.vue';
import PortHandle from './PortHandle.vue';
import { PORT_PREVIEW, type FlowNodeData } from '@/canvas/mapping';

const props = defineProps<{
  data: FlowNodeData;
  selected?: boolean;
}>();

const node = computed(() => props.data.node as TableNode);
const fields = computed<Field[]>(() => node.value.table.fields);
const head = computed<Field[]>(() =>
  props.data.showAllPorts || fields.value.length <= PORT_PREVIEW + 2
    ? fields.value
    : fields.value.slice(0, PORT_PREVIEW),
);
const hidden = computed(() => fields.value.length - head.value.length);

const TYPE_LABEL: Record<string, string> = {
  string: 'string',
  text: 'text',
  number: 'number',
  integer: 'int',
  boolean: 'bool',
  date: 'date',
  datetime: 'datetime',
  enum: 'enum',
  object: 'object',
  array: 'array[]',
  ref: 'ref',
  file: 'file',
  json: 'json',
};
</script>

<template>
  <NodeFrame
    kind="table"
    :title="node.name"
    :subtitle="node.table.dbName"
    :badge="`${fields.length} 字段`"
    :selected="props.selected"
  >
    <div v-for="field in head" :key="field.id" class="row">
      <PortHandle :field-id="field.id" side="in" :kind="field.type" />
      <span class="row__name">{{ field.name }}</span>
      <span v-if="field.required" class="row__req">*</span>
      <span class="row__type">{{ TYPE_LABEL[field.type] ?? field.type }}</span>
      <PortHandle :field-id="field.id" side="out" :kind="field.type" />
    </div>
    <div v-if="hidden > 0" class="row row--more" :style="{ paddingLeft: '14px' }">
      +{{ hidden }} 个字段（打开端口模式查看）
    </div>
    <div v-if="fields.length === 0" class="row row--empty">还没有字段</div>
  </NodeFrame>
</template>

<style scoped>
.row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 14px;
  height: 21px;
  font-size: 11.5px;
  color: var(--text-soft);
  cursor: pointer;
}

.row:hover {
  background: #f8fafc;
}

.row__name {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}

.row__req {
  color: #ef4444;
  font-size: 11px;
  line-height: 1;
}

.row__type {
  font-family: var(--mono);
  font-size: 10px;
  color: var(--text-muted);
  background: #f2f4f7;
  border-radius: 3px;
  padding: 0 4px;
  flex-shrink: 0;
}

.row--more,
.row--empty {
  color: var(--text-muted);
  font-size: 10.5px;
  cursor: default;
}

.row--more:hover,
.row--empty:hover {
  background: transparent;
}
</style>
