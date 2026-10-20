<script setup lang="ts">
import { Handle, Position } from '@vue-flow/core';

import type { FieldType } from '@fsdt/core-ir';

const props = defineProps<{
  fieldId: string;
  side: 'in' | 'out';
  kind: FieldType;
  connected?: boolean;
}>();
</script>

<template>
  <Handle
    :id="`${props.side}:${props.fieldId}`"
    :type="props.side === 'in' ? 'target' : 'source'"
    :position="props.side === 'in' ? Position.Left : Position.Right"
    :class="['fsdt-port', { 'fsdt-port--on': props.connected === true }]"
    :data-kind="props.kind"
  />
</template>

<style scoped>
.fsdt-port {
  width: 9px;
  height: 9px;
  border: 1.5px solid #fff;
  border-radius: 50%;
  background: #cbd5e1;
  transition: background 0.15s ease, transform 0.15s ease;
}

.fsdt-port:hover {
  background: #6366f1;
  transform: scale(1.35);
}

.fsdt-port--on {
  background: #6366f1;
}

.fsdt-port[data-kind='integer'],
.fsdt-port[data-kind='number'] {
  border-radius: 2px;
}

.fsdt-port[data-kind='boolean'] {
  background: #f59e0b;
}

.fsdt-port[data-kind='enum'] {
  background: #10b981;
}

.fsdt-port[data-kind='ref'] {
  background: #ec4899;
}

.fsdt-port[data-kind='json'],
.fsdt-port[data-kind='object'],
.fsdt-port[data-kind='array'] {
  border-radius: 2px;
  background: #8b5cf6;
}
</style>
