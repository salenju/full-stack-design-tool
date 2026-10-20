<script setup lang="ts">
import { computed } from 'vue';

import { newFieldId } from '@fsdt/core-ir';
import type { ApiNode, Field, HttpMethod } from '@fsdt/core-ir';

import FieldListEditor from './FieldListEditor.vue';
import { useProjectStore } from '@/stores/project';
import { useUiStore } from '@/stores/ui';

const props = defineProps<{ node: ApiNode }>();

const project = useProjectStore();
const ui = useUiStore();

const METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

const api = computed(() => props.node.api);
const query = computed(() => api.value.query);
const body = computed(() => api.value.requestBody?.fields ?? []);
const response = computed(() => api.value.responses[0]?.fields ?? []);

function patch(fn: (node: ApiNode) => void): void {
  project.mutate((draft) => {
    const target = draft.nodes.find((n) => n.id === props.node.id);
    if (target !== undefined && target.kind === 'api') fn(target);
  });
}

function setField(key: 'path' | 'summary', value: string): void {
  const text = value.trim();
  if (text.length === 0) return;
  patch((node) => {
    node.api[key] = text;
  });
}

function setMethod(method: HttpMethod): void {
  patch((node) => {
    node.api.method = method;
  });
}

function setAuth(auth: 'none' | 'bearer' | 'apikey'): void {
  patch((node) => {
    node.api.auth = auth;
  });
}

function setTags(value: string): void {
  patch((node) => {
    node.api.tags = value
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
  });
}

function toggleBody(enabled: boolean): void {
  patch((node) => {
    if (enabled) {
      node.api.requestBody = { shape: 'object', fields: [], required: true };
    } else {
      delete node.api.requestBody;
    }
  });
}

function upsert(target: 'query' | 'body' | 'response', field: Field): void {
  const isNew = field.id === '';
  patch((node) => {
    const list =
      target === 'query'
        ? node.api.query
        : target === 'body'
          ? (node.api.requestBody ??= { shape: 'object', fields: [], required: true }).fields
          : (node.api.responses[0] ??= { status: 200, description: '成功', shape: 'array', fields: [] }).fields;
    if (isNew) {
      list.push({ ...field, id: newFieldId() });
      return;
    }
    const index = list.findIndex((f) => f.id === field.id);
    if (index >= 0) list[index] = field;
  });
}

function remove(target: 'query' | 'body' | 'response', fieldId: string): void {
  patch((node) => {
    if (target === 'query') node.api.query = node.api.query.filter((f) => f.id !== fieldId);
    else if (target === 'body') {
      if (node.api.requestBody !== undefined) {
        node.api.requestBody.fields = node.api.requestBody.fields.filter((f) => f.id !== fieldId);
      }
    } else if (node.api.responses[0] !== undefined) {
      node.api.responses[0].fields = node.api.responses[0].fields.filter((f) => f.id !== fieldId);
    }
  });
}

function setStatus(status: number): void {
  patch((node) => {
    if (node.api.responses[0] !== undefined) node.api.responses[0].status = status;
  });
}

function setEnvelope(enabled: boolean): void {
  patch((node) => {
    const first = node.api.responses[0];
    if (first === undefined) return;
    if (enabled) {
      first.envelope = { dataKey: 'items', totalKey: 'total' };
      first.shape = 'array';
    } else {
      delete first.envelope;
    }
  });
}

function addRow(target: 'query' | 'body' | 'response'): void {
  const name = target === 'query' ? `param${String(query.value.length + 1)}` : `field${String(body.value.length + 1)}`;
  upsert(target, { id: '', name, type: 'string', required: false, nullable: true });
  ui.notify('info', '已添加，点字段右侧「⋯」可改约束');
}
</script>

<template>
  <div class="inspector-body">
    <section class="block">
      <div class="block__title">接口</div>
      <label class="row">
        <span class="row__label">名称</span>
        <el-input
          :model-value="props.node.name"
          size="small"
          @change="
            patch((node) => {
              node.name = String($event);
            })
          "
        />
      </label>
      <div class="row">
        <span class="row__label">方法</span>
        <el-select :model-value="api.method" size="small" style="width: 96px" @update:model-value="setMethod($event)">
          <el-option v-for="m in METHODS" :key="m" :label="m" :value="m" />
        </el-select>
        <el-input :model-value="api.path" size="small" class="grow" @change="setField('path', String($event))" />
      </div>
      <label class="row">
        <span class="row__label">说明</span>
        <el-input :model-value="api.summary" size="small" @change="setField('summary', String($event))" />
      </label>
      <label class="row">
        <span class="row__label">标签</span>
        <el-input
          :model-value="api.tags.join(',')"
          size="small"
          placeholder="device,admin"
          @change="setTags(String($event))"
        />
      </label>
      <div class="row">
        <span class="row__label">鉴权</span>
        <el-select :model-value="api.auth" size="small" @update:model-value="setAuth($event)">
          <el-option label="none" value="none" />
          <el-option label="bearer" value="bearer" />
          <el-option label="apikey" value="apikey" />
        </el-select>
      </div>
    </section>

    <section class="block">
      <div class="block__title">
        Query 参数
        <span class="block__count">{{ query.length }}</span>
      </div>
      <FieldListEditor
        :fields="query"
        empty-hint="GET 列表通常需要 page / pageSize"
        @add="addRow('query')"
        @update="(f) => upsert('query', f)"
        @remove="(id) => remove('query', id)"
      />
    </section>

    <section class="block">
      <div class="block__title">
        请求体
        <el-switch
          :model-value="api.requestBody !== undefined"
          size="small"
          style="margin-left: auto"
          @update:model-value="toggleBody($event === true)"
        />
      </div>
      <FieldListEditor
        v-if="api.requestBody !== undefined"
        :fields="body"
        empty-hint="把要提交的字段加进来"
        @add="addRow('body')"
        @update="(f) => upsert('body', f)"
        @remove="(id) => remove('body', id)"
      />
      <div v-else class="empty">没有请求体（GET / DELETE 常见）</div>
    </section>

    <section class="block">
      <div class="block__title">
        响应
        <el-select :model-value="api.responses[0]?.status ?? 200" size="small" style="width: 82px; margin-left: auto" @update:model-value="setStatus(Number($event))">
          <el-option :value="200" label="200" />
          <el-option :value="201" label="201" />
          <el-option :value="204" label="204" />
        </el-select>
      </div>
      <div class="row row--envelope">
        <el-checkbox
          :model-value="api.responses[0]?.envelope !== undefined"
          size="small"
          @update:model-value="setEnvelope($event === true)"
        >
          分页信封 { items, total }
        </el-checkbox>
      </div>
      <FieldListEditor
        :fields="response"
        empty-hint="返回给前端的字段"
        @add="addRow('response')"
        @update="(f) => upsert('response', f)"
        @remove="(id) => remove('response', id)"
      />
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

.grow {
  flex: 1;
  min-width: 0;
}

.row--envelope {
  padding-left: 4px;
}

.empty {
  font-size: 11px;
  color: var(--text-muted);
}
</style>
