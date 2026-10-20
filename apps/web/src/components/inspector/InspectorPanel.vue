<script setup lang="ts">
import { computed } from 'vue';

import type { EdgeKind, IREdge, IRNode, NoteNode } from '@fsdt/core-ir';

import ApiInspector from './ApiInspector.vue';
import PageInspector from './PageInspector.vue';
import TableInspector from './TableInspector.vue';
import { EDGE_LABEL, NODE_LABEL } from '@/canvas/mapping';
import { useProjectStore } from '@/stores/project';
import { useUiStore } from '@/stores/ui';

const project = useProjectStore();
const ui = useUiStore();

const node = computed<IRNode | null>(() => {
  if (ui.selectedNodeId === null) return null;
  return project.ir?.nodes.find((n) => n.id === ui.selectedNodeId) ?? null;
});

const edge = computed<IREdge | null>(() => {
  if (ui.selectedEdgeId === null) return null;
  return project.ir?.edges.find((e) => e.id === ui.selectedEdgeId) ?? null;
});

const EDGE_KINDS: EdgeKind[] = ['call', 'read', 'write', 'map', 'navigate'];

function nameOf(nodeId: string): string {
  return project.ir?.nodes.find((n) => n.id === nodeId)?.name ?? nodeId;
}

function deleteNode(): void {
  const id = ui.selectedNodeId;
  if (id === null) return;
  project.mutate((draft) => {
    draft.nodes = draft.nodes.filter((n) => n.id !== id);
    draft.edges = draft.edges.filter((e) => e.source.nodeId !== id && e.target.nodeId !== id);
  });
  ui.select(null);
}

function deleteEdge(): void {
  const id = ui.selectedEdgeId;
  if (id === null) return;
  project.mutate((draft) => {
    draft.edges = draft.edges.filter((e) => e.id !== id);
  });
  ui.selectEdge(null);
}

function setEdgeKind(kind: EdgeKind): void {
  const id = ui.selectedEdgeId;
  if (id === null) return;
  project.mutate((draft) => {
    const target = draft.edges.find((e) => e.id === id);
    if (target !== undefined) target.kind = kind;
  });
}

function setNoteText(text: string): void {
  const id = ui.selectedNodeId;
  if (id === null) return;
  project.mutate((draft) => {
    const target = draft.nodes.find((n) => n.id === id);
    if (target !== undefined && target.kind === 'note') (target as NoteNode).note.text = text;
  });
}

const enums = computed(() => project.ir?.dictionaries.enums ?? []);
</script>

<template>
  <aside class="inspector">
    <header class="inspector__head">
      <span class="inspector__title">
        {{ node === null ? (edge === null ? '项目' : '连线') : NODE_LABEL[node.kind] }}
      </span>
      <span v-if="node !== null" class="inspector__name">{{ node.name }}</span>
      <button v-if="node !== null" class="inspector__del" type="button" title="删除节点" @click="deleteNode">
        删除
      </button>
      <button v-if="edge !== null" class="inspector__del" type="button" title="删除连线" @click="deleteEdge">
        删除
      </button>
    </header>

    <div class="inspector__scroll">
      <template v-if="node !== null">
        <TableInspector v-if="node.kind === 'table'" :node="node" />
        <ApiInspector v-else-if="node.kind === 'api'" :node="node" />
        <PageInspector v-else-if="node.kind === 'page'" :node="node" />
        <div v-else class="note">
          <el-input
            :model-value="(node as NoteNode).note.text"
            type="textarea"
            :rows="6"
            placeholder="写下这块设计的意图，导出图时会一起带上"
            @change="setNoteText(String($event))"
          />
        </div>
      </template>

      <template v-else-if="edge !== null">
        <div class="edge">
          <div class="edge__row">
            <span class="edge__label">类型</span>
            <el-select :model-value="edge.kind" size="small" @update:model-value="setEdgeKind($event)">
              <el-option v-for="k in EDGE_KINDS" :key="k" :label="`${k}（${EDGE_LABEL[k]}）`" :value="k" />
            </el-select>
          </div>
          <div class="edge__row">
            <span class="edge__label">从</span>
            <span class="edge__value">{{ nameOf(edge.source.nodeId) }}</span>
          </div>
          <div class="edge__row">
            <span class="edge__label">到</span>
            <span class="edge__value">{{ nameOf(edge.target.nodeId) }}</span>
          </div>
          <div v-if="edge.source.fieldId !== undefined" class="edge__row">
            <span class="edge__label">源字段</span>
            <code class="edge__code">{{ edge.source.fieldId }}</code>
          </div>
          <div v-if="edge.target.fieldId !== undefined" class="edge__row">
            <span class="edge__label">目标字段</span>
            <code class="edge__code">{{ edge.target.fieldId }}</code>
          </div>
        </div>
      </template>

      <template v-else>
        <div class="project">
          <div class="project__name">{{ project.ir?.project.name ?? '未加载' }}</div>
          <dl class="kv">
            <dt>节点</dt>
            <dd>{{ project.nodes.length }}</dd>
            <dt>连线</dt>
            <dd>{{ project.ir?.edges.length ?? 0 }}</dd>
            <dt>语义哈希</dt>
            <dd><code>{{ project.schemaHash.slice(0, 16) || '—' }}</code></dd>
            <dt>IR 大小</dt>
            <dd>{{ (project.bytes / 1024).toFixed(1) }} KB</dd>
            <dt>存储</dt>
            <dd class="project__path" :title="project.workspace?.irPath">{{ project.workspace?.irPath }}</dd>
          </dl>

          <div class="project__section">枚举字典</div>
          <div v-if="enums.length === 0" class="project__empty">还没有枚举</div>
          <div v-for="e in enums" :key="e.id" class="enum">
            <span class="enum__name">{{ e.name }}</span>
            <span class="enum__values">{{ e.values.map((v) => v.value).join(' / ') }}</span>
          </div>

          <p class="project__hint">点画布上的节点开始编辑。所有改动会自动保存到 IR 文件。</p>
        </div>
      </template>
    </div>
  </aside>
</template>

<style scoped>
.inspector {
  width: 340px;
  flex-shrink: 0;
  border-left: 1px solid var(--border);
  background: var(--panel);
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.inspector__head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 12px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.inspector__title {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--text-muted);
}

.inspector__name {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}

.inspector__del {
  margin-left: auto;
  border: 1px solid var(--border);
  background: #fff;
  border-radius: 5px;
  padding: 2px 8px;
  font-size: 10.5px;
  color: var(--text-soft);
  cursor: pointer;
  flex-shrink: 0;
}

.inspector__del:hover {
  border-color: #fca5a5;
  color: #ef4444;
  background: #fef2f2;
}

.inspector__scroll {
  padding: 12px;
  overflow-y: auto;
  flex: 1;
  min-height: 0;
}

.note :deep(textarea) {
  font-size: 12px;
  line-height: 1.6;
}

.edge {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.edge__row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.edge__label {
  width: 52px;
  flex-shrink: 0;
  font-size: 11px;
  color: var(--text-muted);
}

.edge__value {
  font-size: 12px;
  color: var(--text);
}

.edge__code {
  font-size: 10.5px;
  color: var(--text-soft);
  background: #f2f4f7;
  padding: 1px 5px;
  border-radius: 3px;
}

.project {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.project__name {
  font-size: 14px;
  font-weight: 600;
}

.kv {
  display: grid;
  grid-template-columns: 62px 1fr;
  gap: 5px 8px;
  margin: 0;
  font-size: 11.5px;
}

.kv dt {
  color: var(--text-muted);
}

.kv dd {
  margin: 0;
  color: var(--text-soft);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.project__path {
  font-family: var(--mono);
  font-size: 10px;
  direction: rtl;
  text-align: left;
}

.project__section {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--text-muted);
  border-top: 1px dashed var(--border);
  padding-top: 10px;
}

.project__empty {
  font-size: 11px;
  color: var(--text-muted);
}

.enum {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.enum__name {
  font-size: 12px;
  color: var(--text);
  font-family: var(--mono);
}

.enum__values {
  font-size: 10.5px;
  color: var(--text-muted);
}

.project__hint {
  margin: 8px 0 0;
  font-size: 10.5px;
  color: var(--text-muted);
  line-height: 1.6;
  background: #f8fafc;
  border-radius: 6px;
  padding: 8px;
}
</style>
