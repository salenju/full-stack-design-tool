<script setup lang="ts">
import { Handle, Position } from '@vue-flow/core';

import type { NodeKind } from '@fsdt/core-ir';

const props = defineProps<{
  kind: NodeKind;
  title: string;
  subtitle?: string;
  selected?: boolean;
  badge?: string;
}>();

const COLORS: Record<NodeKind, string> = {
  table: 'var(--kind-table)',
  api: 'var(--kind-api)',
  page: 'var(--kind-page)',
  note: 'var(--kind-note)',
};
</script>

<template>
  <div class="node" :class="{ 'node--selected': props.selected === true }" :data-kind="props.kind">
    <!-- 默认端口：用于「页面 → 接口」这类不落到字段的连线 -->
    <Handle
      type="target"
      :position="Position.Left"
      class="node__port node__port--default"
      :style="{ top: '17px' }"
    />
    <Handle
      type="source"
      :position="Position.Right"
      class="node__port node__port--default"
      :style="{ top: '17px' }"
    />

    <header class="node__head" :style="{ '--accent': COLORS[props.kind] }">
      <span class="node__dot" />
      <span class="node__title">{{ props.title }}</span>
      <span v-if="props.subtitle !== undefined" class="node__subtitle">{{ props.subtitle }}</span>
      <span v-if="props.badge !== undefined" class="node__badge">{{ props.badge }}</span>
    </header>

    <div class="node__body">
      <slot />
    </div>

    <footer v-if="$slots.footer !== undefined" class="node__foot">
      <slot name="footer" />
    </footer>
  </div>
</template>

<style scoped>
.node {
  width: 272px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: var(--shadow-sm);
  overflow: visible;
  transition: box-shadow 0.16s ease, border-color 0.16s ease;
  position: relative;
}

.node:hover {
  box-shadow: var(--shadow-md);
}

.node--selected {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px rgba(79, 70, 229, 0.14), var(--shadow-md);
}

.node__head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 10px;
  border-bottom: 1px solid var(--border);
  border-radius: 10px 10px 0 0;
  background: linear-gradient(180deg, #fcfcfd, #f8f9fb);
}

.node__dot {
  width: 7px;
  height: 7px;
  border-radius: 2px;
  background: var(--accent);
  flex-shrink: 0;
}

.node__title {
  font-weight: 600;
  font-size: 12.5px;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 130px;
}

.node__subtitle {
  font-family: var(--mono);
  font-size: 10.5px;
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
  min-width: 0;
}

.node__badge {
  margin-left: auto;
  font-size: 10px;
  color: var(--text-soft);
  background: #f2f4f7;
  border-radius: 999px;
  padding: 1px 6px;
  flex-shrink: 0;
}

.node__body {
  padding: 4px 0;
}

.node__foot {
  border-top: 1px dashed var(--border);
  padding: 4px 10px;
  font-size: 10.5px;
  color: var(--text-muted);
}

.node__port {
  width: 8px;
  height: 8px;
  background: #cbd5e1;
  border: 1.5px solid #fff;
}

.node__port--default {
  opacity: 0.55;
}

.node__port--default:hover {
  opacity: 1;
  background: var(--accent);
}
</style>
