<script setup lang="ts">
import { createApiNode, createNoteNode, createPageNode, createTableNode } from '@fsdt/core-ir';
import type { IRNode, NodeKind } from '@fsdt/core-ir';
import { autoLayout } from '@/canvas/layout';
import { useProjectStore } from '@/stores/project';
import { useUiStore } from '@/stores/ui';

interface PaletteItem {
  kind: NodeKind;
  label: string;
  hint: string;
  color: string;
}

const ITEMS: PaletteItem[] = [
  { kind: 'table', label: '数据表', hint: '实体与字段', color: 'var(--kind-table)' },
  { kind: 'api', label: '接口', hint: 'method + path', color: 'var(--kind-api)' },
  { kind: 'page', label: '页面', hint: '路由与组件', color: 'var(--kind-page)' },
  { kind: 'note', label: '备注', hint: '说明文字', color: 'var(--kind-note)' },
];

const project = useProjectStore();
const ui = useUiStore();

function startDrag(event: DragEvent, kind: NodeKind): void {
  event.dataTransfer?.setData('application/fsdt-node', kind);
  if (event.dataTransfer !== null) event.dataTransfer.effectAllowed = 'copy';
}

/** 点击添加：放在现有节点的最右侧，避免叠在一起 */
function nextPosition(): { x: number; y: number } {
  const nodes = project.nodes;
  if (nodes.length === 0) return { x: 80, y: 80 };
  const maxX = Math.max(...nodes.map((n) => n.position.x));
  return { x: maxX + 320, y: 80 };
}

function add(kind: NodeKind): void {
  const ir = project.ir;
  if (ir === null) return;
  const canvasId = ir.canvases[0]?.id ?? 'cv_default';
  const position = nextPosition();
  const created: IRNode = (() => {
    switch (kind) {
      case 'table':
        return createTableNode({ name: '新数据表', canvasId, position });
      case 'api':
        return createApiNode({ name: '新接口', canvasId, position });
      case 'page':
        return createPageNode({ name: '新页面', canvasId, position });
      default:
        return createNoteNode({ name: '备注', canvasId, position, note: { text: '写点什么…' } });
    }
  })();
  project.mutate((draft) => {
    draft.nodes.push(created);
  });
  // 新节点可能落在视口外（点「整理布局」之后尤其如此），这里顺手把视口带过去
  ui.focus(created.id);
}

function runAutoLayout(): void {
  const nodes = project.nodes;
  if (nodes.length === 0) return;
  const positions = autoLayout(nodes);
  const byId = new Map(positions.map((p) => [p.id, p.position]));
  project.mutate((draft) => {
    for (const node of draft.nodes) {
      const next = byId.get(node.id);
      if (next !== undefined) node.position = next;
    }
  });
  ui.notify('success', '已按「表 → 接口 → 页面」重新排列');
}
</script>

<template>
  <aside class="palette">
    <div class="palette__title">节点库</div>
    <button
      v-for="item in ITEMS"
      :key="item.kind"
      class="palette__item"
      draggable="true"
      type="button"
      @dragstart="startDrag($event, item.kind)"
      @click="add(item.kind)"
    >
      <span class="palette__dot" :style="{ background: item.color }" />
      <span class="palette__text">
        <span class="palette__label">{{ item.label }}</span>
        <span class="palette__hint">{{ item.hint }}</span>
      </span>
    </button>

    <div class="palette__tip">
      <p>拖拽到画布任意位置，或点击直接添加。</p>
      <p>从字段右侧的圆点拖到另一节点，可建立字段级连线。</p>
    </div>

    <div class="palette__spacer" />

    <button class="palette__action" type="button" @click="runAutoLayout">整理布局</button>

    <label class="palette__switch">
      <el-switch v-model="ui.portMode" size="small" />
      <span>端口模式</span>
    </label>
  </aside>
</template>

<style scoped>
.palette {
  width: 176px;
  flex-shrink: 0;
  border-right: 1px solid var(--border);
  background: var(--panel);
  padding: 12px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  overflow-y: auto;
}

.palette__title {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-muted);
  padding: 0 4px 4px;
}

.palette__item {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 8px 9px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: #fff;
  cursor: grab;
  text-align: left;
  transition: border-color 0.15s ease, box-shadow 0.15s ease, transform 0.1s ease;
}

.palette__item:hover {
  border-color: var(--border-strong);
  box-shadow: var(--shadow-sm);
}

.palette__item:active {
  cursor: grabbing;
  transform: scale(0.985);
}

.palette__dot {
  width: 8px;
  height: 8px;
  border-radius: 3px;
  flex-shrink: 0;
}

.palette__text {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.palette__label {
  font-size: 12.5px;
  color: var(--text);
  font-weight: 500;
}

.palette__hint {
  font-size: 10.5px;
  color: var(--text-muted);
}

.palette__tip {
  margin-top: 8px;
  padding: 8px 9px;
  background: #f8fafc;
  border-radius: var(--radius);
  color: var(--text-muted);
  font-size: 10.5px;
  line-height: 1.6;
}

.palette__tip p {
  margin: 0 0 4px;
}

.palette__tip p:last-child {
  margin-bottom: 0;
}

.palette__spacer {
  flex: 1;
}

.palette__switch {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--text-soft);
  padding: 4px;
}

.palette__action {
  border: 1px solid var(--border);
  background: #fff;
  border-radius: var(--radius);
  padding: 5px 8px;
  font-size: 11px;
  color: var(--text-soft);
  cursor: pointer;
  margin-bottom: 4px;
}

.palette__action:hover {
  border-color: var(--border-strong);
  color: var(--text);
  background: #fcfcfd;
}
</style>
