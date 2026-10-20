<script setup lang="ts">
import { computed } from 'vue';

import type { NoteNode } from '@fsdt/core-ir';

import NodeFrame from './NodeFrame.vue';
import type { FlowNodeData } from '@/canvas/mapping';

const props = defineProps<{
  data: FlowNodeData;
  selected?: boolean;
}>();

const node = computed(() => props.data.node as NoteNode);
</script>

<template>
  <NodeFrame kind="note" title="备注" :selected="props.selected">
    <div class="note">{{ node.note.text }}</div>
  </NodeFrame>
</template>

<style scoped>
.note {
  padding: 2px 12px 6px;
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--text-soft);
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
