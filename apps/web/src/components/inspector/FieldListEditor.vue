<script setup lang="ts">
import { ref } from 'vue';

import type { Field, FieldType } from '@fsdt/core-ir';

import FieldDialog from './FieldDialog.vue';

const props = defineProps<{
  fields: Field[];
  /** 只读分区（如响应字段）不允许增删 */
  editable?: boolean;
  emptyHint?: string;
}>();

const emit = defineEmits<{
  add: [];
  update: [field: Field];
  remove: [fieldId: string];
}>();

const dialogOpen = ref(false);
const editing = ref<Field | null>(null);

const TYPES: FieldType[] = ['string', 'text', 'number', 'integer', 'boolean', 'date', 'datetime', 'enum', 'array', 'ref', 'json'];

function openNew(): void {
  editing.value = null;
  dialogOpen.value = true;
}

function openEdit(field: Field): void {
  editing.value = field;
  dialogOpen.value = true;
}

function submit(field: Field): void {
  emit('update', field);
}

function rename(field: Field, name: string): void {
  const next = name.trim();
  if (next.length === 0 || next === field.name) return;
  emit('update', { ...field, name: next });
}

function retype(field: Field, type: FieldType): void {
  if (type === field.type) return;
  emit('update', { ...field, type });
}
</script>

<template>
  <div class="fl">
    <div v-for="field in props.fields" :key="field.id" class="fl__row">
      <el-input
        :model-value="field.name"
        class="fl__name"
        size="small"
        @change="rename(field, String($event))"
      />
      <el-select
        :model-value="field.type"
        class="fl__type"
        size="small"
        @update:model-value="retype(field, $event as FieldType)"
      >
        <el-option v-for="t in TYPES" :key="t" :label="t" :value="t" />
      </el-select>
      <span v-if="field.required" class="fl__req" title="必填">*</span>
      <span v-else class="fl__req fl__req--off" title="可选">·</span>
      <button class="fl__btn" type="button" title="编辑约束" @click="openEdit(field)">⋯</button>
      <button
        v-if="props.editable !== false"
        class="fl__btn fl__btn--danger"
        type="button"
        title="删除字段"
        @click="emit('remove', field.id)"
      >
        ×
      </button>
    </div>

    <div v-if="props.fields.length === 0" class="fl__empty">
      {{ props.emptyHint ?? '还没有字段' }}
    </div>

    <button v-if="props.editable !== false" class="fl__add" type="button" @click="openNew">
      + 添加字段
    </button>

    <FieldDialog v-model="dialogOpen" :field="editing" @submit="submit" />
  </div>
</template>

<style scoped>
.fl {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.fl__row {
  display: flex;
  align-items: center;
  gap: 4px;
}

.fl__name {
  flex: 1;
  min-width: 0;
}

.fl__name :deep(.el-input__wrapper) {
  box-shadow: none;
  background: transparent;
  padding: 0 4px;
}

.fl__name :deep(.el-input__wrapper:hover) {
  background: #f2f4f7;
}

.fl__name :deep(.el-input__inner) {
  font-family: var(--mono);
  font-size: 11px;
  height: 22px;
}

.fl__type {
  width: 84px;
  flex-shrink: 0;
}

.fl__type :deep(.el-select__wrapper) {
  min-height: 22px;
  font-size: 10.5px;
  box-shadow: none;
  background: #f2f4f7;
  padding: 0 6px;
}

.fl__req {
  color: #ef4444;
  font-size: 11px;
  width: 8px;
  text-align: center;
  flex-shrink: 0;
}

.fl__req--off {
  color: #cbd5e1;
}

.fl__btn {
  width: 20px;
  height: 20px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  border-radius: 4px;
  font-size: 13px;
  line-height: 1;
  flex-shrink: 0;
}

.fl__btn:hover {
  background: #f2f4f7;
  color: var(--text);
}

.fl__btn--danger:hover {
  background: #fef2f2;
  color: #ef4444;
}

.fl__empty {
  font-size: 11px;
  color: var(--text-muted);
  padding: 6px 4px;
}

.fl__add {
  margin-top: 4px;
  padding: 5px 8px;
  border: 1px dashed var(--border-strong);
  border-radius: 6px;
  background: transparent;
  color: var(--text-soft);
  font-size: 11.5px;
  cursor: pointer;
}

.fl__add:hover {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-soft);
}
</style>
