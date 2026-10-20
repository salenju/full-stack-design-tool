<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import { defaultConstraintsFor } from '@fsdt/core-ir';
import type { Field, FieldType } from '@fsdt/core-ir';

import { useProjectStore } from '@/stores/project';

const props = defineProps<{
  modelValue: boolean;
  field: Field | null;
  /** 新建时的默认名（如 form 里的第 n 个字段） */
  defaultName?: string;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  submit: [field: Field];
}>();

const project = useProjectStore();

const FIELD_TYPES: FieldType[] = [
  'string',
  'text',
  'number',
  'integer',
  'boolean',
  'date',
  'datetime',
  'enum',
  'object',
  'array',
  'ref',
  'file',
  'json',
];

const draft = ref<Field | null>(null);

watch(
  () => [props.modelValue, props.field] as const,
  ([open, field]) => {
    if (!open) return;
    if (field !== null) {
      draft.value = structuredClone(field);
      return;
    }
    draft.value = {
      id: '',
      name: props.defaultName ?? 'newField',
      type: 'string',
      required: true,
      nullable: false,
      constraints: { maxLength: 64 },
    };
  },
  { immediate: true },
);

const enums = computed(() => project.ir?.dictionaries.enums ?? []);
const constraints = computed(() => draft.value?.constraints ?? {});

function patchConstraints(key: string, value: unknown): void {
  if (draft.value === null) return;
  const next = { ...(draft.value.constraints ?? {}) };
  if (value === undefined || value === '' || value === null) {
    delete (next as Record<string, unknown>)[key];
  } else {
    (next as Record<string, unknown>)[key] = value;
  }
  draft.value = { ...draft.value, constraints: next };
}

function onTypeChange(type: FieldType): void {
  if (draft.value === null) return;
  // 换类型时把旧类型的约束清掉：留着 minLength 的整数会生成非法的 JSON Schema
  draft.value = { ...draft.value, type, constraints: defaultConstraintsFor(type) ?? {} };
}

function submit(): void {
  if (draft.value === null) return;
  if (draft.value.name.trim().length === 0) return;
  emit('submit', draft.value);
  emit('update:modelValue', false);
}

function close(): void {
  emit('update:modelValue', false);
}
</script>

<template>
  <el-dialog
    :model-value="props.modelValue"
    :title="props.field === null ? '新增字段' : '编辑字段'"
    width="560px"
    append-to-body
    @update:model-value="close"
  >
    <div v-if="draft !== null" class="form">
      <div class="grid2">
        <label class="field">
          <span class="field__label">字段名</span>
          <el-input v-model="draft.name" size="small" placeholder="camelCase，如 deviceName" />
        </label>
        <label class="field">
          <span class="field__label">类型</span>
          <el-select :model-value="draft.type" size="small" @update:model-value="onTypeChange">
            <el-option v-for="t in FIELD_TYPES" :key="t" :label="t" :value="t" />
          </el-select>
        </label>
      </div>

      <label class="field">
        <span class="field__label">中文名 / 注释</span>
        <el-input v-model="draft.comment" size="small" placeholder="会写进 OpenAPI description 与前端 label" />
      </label>

      <div class="grid2">
        <label class="field">
          <span class="field__label">数据库列名</span>
          <el-input v-model="draft.dbName" size="small" placeholder="留空则按 snake_case 推导" />
        </label>
        <div class="field">
          <span class="field__label">标记</span>
          <div class="flags">
            <el-checkbox v-model="draft.required" size="small">必填</el-checkbox>
            <el-checkbox v-model="draft.nullable" size="small">可空</el-checkbox>
            <el-checkbox v-model="draft.readOnly" size="small">只读</el-checkbox>
            <el-checkbox v-model="draft.sensitive" size="small">敏感</el-checkbox>
          </div>
        </div>
      </div>

      <div class="divider">约束</div>

      <div v-if="draft.type === 'enum'" class="grid2">
        <label class="field">
          <span class="field__label">引用枚举字典</span>
          <el-select
            :model-value="constraints.enumRef ?? ''"
            size="small"
            clearable
            placeholder="选择枚举"
            @update:model-value="patchConstraints('enumRef', $event || undefined)"
          >
            <el-option v-for="e in enums" :key="e.id" :label="`${e.name}（${e.values.length} 值）`" :value="e.id" />
          </el-select>
        </label>
        <label class="field">
          <span class="field__label">或内联枚举值（逗号分隔）</span>
          <el-input
            :model-value="(constraints.enumValues ?? []).join(',')"
            size="small"
            placeholder="ACTIVE,OFFLINE"
            @change="
              patchConstraints(
                'enumValues',
                String($event).trim() === ''
                  ? undefined
                  : String($event)
                      .split(',')
                      .map((v) => v.trim())
                      .filter((v) => v.length > 0),
              )
            "
          />
        </label>
      </div>

      <div v-if="draft.type === 'ref'" class="grid2">
        <label class="field">
          <span class="field__label">外键指向的表</span>
          <el-select
            :model-value="constraints.ref?.tableId ?? ''"
            size="small"
            clearable
            @update:model-value="
              patchConstraints('ref', $event ? { tableId: String($event), onDelete: 'restrict' } : undefined)
            "
          >
            <el-option
              v-for="t in project.nodes.filter((n) => n.kind === 'table')"
              :key="t.id"
              :label="t.name"
              :value="t.id"
            />
          </el-select>
        </label>
        <label class="field">
          <span class="field__label">删除行为</span>
          <el-select
            :model-value="constraints.ref?.onDelete ?? 'restrict'"
            size="small"
            :disabled="constraints.ref === undefined"
            @update:model-value="patchConstraints('ref', { ...(constraints.ref ?? { tableId: '' }), onDelete: $event })"
          >
            <el-option label="restrict" value="restrict" />
            <el-option label="cascade" value="cascade" />
            <el-option label="setNull" value="setNull" />
          </el-select>
        </label>
      </div>

      <div v-if="draft.type === 'array'" class="grid1">
        <label class="field">
          <span class="field__label">元素类型</span>
          <el-select
            :model-value="constraints.arrayItem ?? 'string'"
            size="small"
            @update:model-value="patchConstraints('arrayItem', $event)"
          >
            <el-option v-for="t in FIELD_TYPES.filter((x) => x !== 'array')" :key="t" :label="t" :value="t" />
          </el-select>
        </label>
      </div>

      <div v-if="draft.type === 'string' || draft.type === 'text'" class="grid3">
        <label class="field">
          <span class="field__label">最小长度</span>
          <el-input-number
            :model-value="constraints.minLength"
            :min="0"
            size="small"
            controls-position="right"
            @update:model-value="patchConstraints('minLength', $event ?? undefined)"
          />
        </label>
        <label class="field">
          <span class="field__label">最大长度</span>
          <el-input-number
            :model-value="constraints.maxLength"
            :min="0"
            size="small"
            controls-position="right"
            @update:model-value="patchConstraints('maxLength', $event ?? undefined)"
          />
        </label>
        <label class="field">
          <span class="field__label">正则</span>
          <el-input
            :model-value="constraints.pattern"
            size="small"
            placeholder="^[a-z]+$"
            @change="patchConstraints('pattern', String($event) || undefined)"
          />
        </label>
      </div>

      <div v-if="draft.type === 'number' || draft.type === 'integer'" class="grid2">
        <label class="field">
          <span class="field__label">最小值</span>
          <el-input-number
            :model-value="constraints.minimum"
            size="small"
            controls-position="right"
            @update:model-value="patchConstraints('minimum', $event ?? undefined)"
          />
        </label>
        <label class="field">
          <span class="field__label">最大值</span>
          <el-input-number
            :model-value="constraints.maximum"
            size="small"
            controls-position="right"
            @update:model-value="patchConstraints('maximum', $event ?? undefined)"
          />
        </label>
      </div>
    </div>

    <template #footer>
      <el-button size="small" @click="close">取消</el-button>
      <el-button size="small" type="primary" @click="submit">确定</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.grid1 {
  display: grid;
  grid-template-columns: 1fr;
  gap: 10px;
}

.grid2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.grid3 {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 10px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.field__label {
  font-size: 11px;
  color: var(--text-soft);
}

.flags {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  padding-top: 2px;
}

.divider {
  font-size: 11px;
  color: var(--text-muted);
  border-top: 1px dashed var(--border);
  padding-top: 8px;
}
</style>
