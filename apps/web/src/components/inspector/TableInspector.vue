<script setup lang="ts">
import { computed } from 'vue';

import { newFieldId, toSnakeCase } from '@fsdt/core-ir';
import type { Field, TableNode } from '@fsdt/core-ir';

import FieldListEditor from './FieldListEditor.vue';
import { useProjectStore } from '@/stores/project';
import { useUiStore } from '@/stores/ui';

const props = defineProps<{ node: TableNode }>();

const project = useProjectStore();
const ui = useUiStore();

const fields = computed(() => props.node.table.fields);
const pk = computed(() => fields.value.find((f) => f.name === 'id' && f.required) ?? null);

function patch(fn: (node: TableNode) => void): void {
  project.mutate((draft) => {
    const target = draft.nodes.find((n) => n.id === props.node.id);
    if (target !== undefined && target.kind === 'table') fn(target);
  });
}

function setName(value: string): void {
  const name = value.trim();
  if (name.length === 0 || name === props.node.name) return;
  patch((node) => {
    node.name = name;
  });
}

function setCodeName(value: string): void {
  const codeName = value.trim();
  if (codeName.length === 0 || codeName === props.node.codeName) return;
  patch((node) => {
    node.codeName = codeName;
  });
}

function setDbName(value: string): void {
  const dbName = value.trim();
  patch((node) => {
    node.table.dbName = dbName;
  });
}

function setComment(value: string): void {
  patch((node) => {
    node.table.comment = value;
  });
}

function setFlag(key: 'softDelete' | 'timestamps', value: boolean): void {
  patch((node) => {
    node.table[key] = value;
  });
}

function upsertField(field: Field): void {
  const isNew = field.id === '';
  patch((node) => {
    if (isNew) {
      node.table.fields.push({
        ...field,
        id: newFieldId(),
        dbName: field.dbName ?? toSnakeCase(field.name),
      });
      return;
    }
    const index = node.table.fields.findIndex((f) => f.id === field.id);
    if (index >= 0) node.table.fields[index] = field;
  });
  ui.notify('success', isNew ? '已添加字段' : '已更新字段');
}

function removeField(fieldId: string): void {
  patch((node) => {
    node.table.fields = node.table.fields.filter((f) => f.id !== fieldId);
    // 索引里留着已删字段的 ID，会让 Prisma schema 生成一个不存在的列
    node.table.indexes = node.table.indexes.map((i) => ({
      ...i,
      fieldIds: i.fieldIds.filter((id) => id !== fieldId),
    }));
  });
}

function addField(): void {
  upsertField({
    id: '',
    name: `field${String(fields.value.length + 1)}`,
    type: 'string',
    required: false,
    nullable: true,
  });
}
</script>

<template>
  <div class="inspector-body">
    <section class="block">
      <div class="block__title">数据表</div>
      <label class="row">
        <span class="row__label">名称</span>
        <el-input :model-value="props.node.name" size="small" @change="setName(String($event))" />
      </label>
      <label class="row">
        <span class="row__label">模型名</span>
        <el-input :model-value="props.node.codeName" size="small" @change="setCodeName(String($event))" />
      </label>
      <label class="row">
        <span class="row__label">表名</span>
        <el-input :model-value="props.node.table.dbName" size="small" @change="setDbName(String($event))" />
      </label>
      <label class="row">
        <span class="row__label">注释</span>
        <el-input :model-value="props.node.table.comment" size="small" @change="setComment(String($event))" />
      </label>
      <div class="row row--flags">
        <el-checkbox
          :model-value="props.node.table.timestamps"
          size="small"
          @update:model-value="setFlag('timestamps', $event === true)"
        >
          createdAt / updatedAt
        </el-checkbox>
        <el-checkbox
          :model-value="props.node.table.softDelete"
          size="small"
          @update:model-value="setFlag('softDelete', $event === true)"
        >
          软删除
        </el-checkbox>
      </div>
      <div class="meta">
        主键：<code>{{ pk?.name ?? '未识别（需要一个 required 的 id 字段）' }}</code>
      </div>
    </section>

    <section class="block">
      <div class="block__title">
        字段
        <span class="block__count">{{ fields.length }}</span>
      </div>
      <FieldListEditor
        :fields="fields"
        empty-hint="先加一个 id 字段（integer，必填）"
        @add="addField"
        @update="upsertField"
        @remove="removeField"
      />
    </section>

    <section class="block">
      <div class="block__title">索引</div>
      <div v-if="props.node.table.indexes.length === 0" class="empty">没有显式索引</div>
      <div v-for="index in props.node.table.indexes" :key="index.id" class="idx">
        <code>{{ index.fieldIds.join(', ') }}</code>
        <span v-if="index.unique" class="idx__unique">unique</span>
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
  width: 48px;
  flex-shrink: 0;
  font-size: 11px;
  color: var(--text-soft);
}

.row--flags {
  flex-wrap: wrap;
  gap: 4px;
  padding-left: 56px;
}

.meta {
  font-size: 10.5px;
  color: var(--text-muted);
  padding-left: 56px;
}

.meta code {
  font-size: 10.5px;
  color: var(--text-soft);
}

.empty {
  font-size: 11px;
  color: var(--text-muted);
}

.idx {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
}

.idx__unique {
  font-size: 9.5px;
  color: #10b981;
  background: #ecfdf5;
  border-radius: 3px;
  padding: 0 4px;
}
</style>
