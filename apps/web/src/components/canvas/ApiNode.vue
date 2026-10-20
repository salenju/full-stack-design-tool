<script setup lang="ts">
import { computed } from 'vue';

import type { ApiNode, Field } from '@fsdt/core-ir';

import NodeFrame from './NodeFrame.vue';
import PortHandle from './PortHandle.vue';
import { PORT_PREVIEW, type FlowNodeData } from '@/canvas/mapping';

const props = defineProps<{
  data: FlowNodeData;
  selected?: boolean;
}>();

const node = computed(() => props.data.node as ApiNode);
const api = computed(() => node.value.api);

const METHOD_COLOR: Record<string, string> = {
  GET: '#0ea5e9',
  POST: '#10b981',
  PUT: '#f59e0b',
  PATCH: '#8b5cf6',
  DELETE: '#ef4444',
};

interface Section {
  key: string;
  label: string;
  fields: Field[];
  total: number;
}

const sections = computed<Section[]>(() => {
  const out: Section[] = [];
  const push = (key: string, label: string, all: Field[]): void => {
    if (all.length === 0) return;
    const shown = props.data.showAllPorts || all.length <= PORT_PREVIEW + 2 ? all : all.slice(0, PORT_PREVIEW);
    out.push({ key, label, fields: shown, total: all.length });
  };
  push('query', 'query', api.value.query);
  push('body', 'body', api.value.requestBody?.fields ?? []);
  push('resp', `响应 ${String(api.value.responses[0]?.status ?? 200)}`, api.value.responses[0]?.fields ?? []);
  return out;
});
</script>

<template>
  <NodeFrame
    kind="api"
    :title="node.name"
    :subtitle="api.path"
    :selected="props.selected"
    :badge="api.auth === 'none' ? undefined : api.auth"
  >
    <div class="method" :style="{ background: METHOD_COLOR[api.method] ?? '#64748b' }">
      {{ api.method }}
    </div>

    <div v-for="section in sections" :key="section.key" class="section">
      <div class="section__label">
        {{ section.label }}
        <span v-if="section.total > section.fields.length" class="section__more">
          +{{ section.total - section.fields.length }}
        </span>
      </div>
      <div v-for="field in section.fields" :key="field.id" class="row">
        <PortHandle :field-id="field.id" side="in" :kind="field.type" />
        <span class="row__name">{{ field.name }}</span>
        <span v-if="field.required" class="row__req">*</span>
        <PortHandle :field-id="field.id" side="out" :kind="field.type" />
      </div>
    </div>

    <div v-if="sections.length === 0" class="row row--empty">没有参数</div>
  </NodeFrame>
</template>

<style scoped>
.method {
  display: inline-block;
  margin: 2px 10px 4px;
  padding: 1px 7px;
  border-radius: 4px;
  color: #fff;
  font-family: var(--mono);
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 0.03em;
}

.section {
  padding-bottom: 2px;
}

.section__label {
  padding: 2px 12px;
  font-size: 9.5px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-muted);
  display: flex;
  gap: 4px;
  align-items: center;
}

.section__more {
  color: var(--text-muted);
  font-size: 9px;
}

.row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 1px 14px;
  height: 20px;
  font-size: 11.5px;
}

.row:hover {
  background: #f8fafc;
}

.row__name {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text);
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row__req {
  color: #ef4444;
  font-size: 11px;
  line-height: 1;
}

.row--empty {
  color: var(--text-muted);
  font-size: 10.5px;
  padding-left: 14px;
}
</style>
