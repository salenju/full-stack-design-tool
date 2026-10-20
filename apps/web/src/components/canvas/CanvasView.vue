<script setup lang="ts">
import { onMounted, watch } from 'vue';
import { ConnectionMode, VueFlow, useVueFlow } from '@vue-flow/core';
import type { Connection, Edge, EdgeChange, NodeChange, NodeDragEvent } from '@vue-flow/core';
import { Background } from '@vue-flow/background';
import { Controls } from '@vue-flow/controls';

import { createApiNode, createNoteNode, createPageNode, createTableNode, newEdgeId } from '@fsdt/core-ir';
import type { IRNode, NodeKind } from '@fsdt/core-ir';

import ApiNode from './ApiNode.vue';
import NoteNode from './NoteNode.vue';
import PageNode from './PageNode.vue';
import TableNode from './TableNode.vue';
import { inferEdgeKind, toFlowEdges, toFlowNodes, type FlowNodeData } from '@/canvas/mapping';
import { useProjectStore } from '@/stores/project';
import { useUiStore } from '@/stores/ui';

const project = useProjectStore();
const ui = useUiStore();

/**
 * 节点组件用 slot 注册而不是 nodeTypes：Vue Flow 的 NodeTypesObject 要求
 * 组件 props 与 NodeProps 完全一致，而我们的节点只吃 data/selected，
 * 硬塞进去要么用 as any，要么把四个组件都改成接收整包 NodeProps。
 */
const {
  addNodes,
  addEdges,
  removeNodes,
  removeEdges,
  updateNode,
  findNode,
  getNodes,
  getEdges,
  setEdges,
  screenToFlowCoordinate,
  fitView,
  onConnect,
  onNodeDragStop,
  onNodeClick,
  onEdgeClick,
  onPaneClick,
  onNodesChange,
  onEdgesChange,
} = useVueFlow();

function parseHandle(handle: string | null | undefined): { side: 'in' | 'out'; fieldId: string } | null {
  if (handle === null || handle === undefined) return null;
  const index = handle.indexOf(':');
  if (index < 0) return null;
  const side = handle.slice(0, index);
  if (side !== 'in' && side !== 'out') return null;
  return { side, fieldId: handle.slice(index + 1) };
}

/** 把画布上的一次连接写成 IR 的边；能用类型推断的就不再问用户 */
function handleConnect(connection: Connection): void {
  const ir = project.ir;
  if (ir === null) return;
  const source = findNode(connection.source);
  const target = findNode(connection.target);
  const sourceKind = (source?.data as FlowNodeData | undefined)?.kind;
  const targetKind = (target?.data as FlowNodeData | undefined)?.kind;

  const sourceField = parseHandle(connection.sourceHandle);
  const targetField = parseHandle(connection.targetHandle);
  const kind = inferEdgeKind(sourceKind, targetKind, sourceField !== null && targetField !== null);
  const canvasId = ir.canvases[0]?.id ?? 'cv_default';

  project.mutate((draft) => {
    draft.edges.push({
      id: newEdgeId(),
      kind,
      source: {
        nodeId: connection.source,
        ...(sourceField !== null ? { fieldId: sourceField.fieldId, port: 'out' as const } : {}),
      },
      target: {
        nodeId: connection.target,
        ...(targetField !== null ? { fieldId: targetField.fieldId, port: 'in' as const } : {}),
      },
      canvasId,
    });
  });
  ui.notify('info', `已创建「${kind}」连线`);
}

function handleDragStop(event: NodeDragEvent): void {
  const node = event.node;
  const ir = project.ir;
  if (ir === null) return;
  const current = ir.nodes.find((n) => n.id === node.id);
  if (current === undefined) return;
  const { x, y } = node.position;
  if (Math.abs(current.position.x - x) < 0.5 && Math.abs(current.position.y - y) < 0.5) return;
  project.mutate((draft) => {
    const target = draft.nodes.find((n) => n.id === node.id);
    if (target !== undefined) target.position = { x: Math.round(x), y: Math.round(y) };
  });
}

/**
 * 删除走 change 事件而不是 delete 事件：Vue Flow 1.48 的删除是以
 * `nodesChange` 里 type === 'remove' 的形式发出来的，没有独立的 delete 钩子。
 */
function handleNodesChange(changes: NodeChange[]): void {
  const removed = changes.filter((c) => c.type === 'remove').map((c) => c.id);
  if (removed.length === 0) return;
  const ids = new Set(removed);
  project.mutate((draft) => {
    draft.nodes = draft.nodes.filter((n) => !ids.has(n.id));
    draft.edges = draft.edges.filter((e) => !ids.has(e.source.nodeId) && !ids.has(e.target.nodeId));
  });
  if (ui.selectedNodeId !== null && ids.has(ui.selectedNodeId)) ui.select(null);
}

function handleEdgesChange(changes: EdgeChange[]): void {
  const removed = changes.filter((c) => c.type === 'remove').map((c) => c.id);
  if (removed.length === 0) return;
  const ids = new Set(removed);
  project.mutate((draft) => {
    draft.edges = draft.edges.filter((e) => !ids.has(e.id));
  });
}

onConnect(handleConnect);
onNodeDragStop(handleDragStop);
onNodeClick(({ node }) => {
  ui.select(node.id);
});
onEdgeClick(({ edge }) => {
  ui.selectEdge(edge.id);
});
onPaneClick(() => {
  ui.select(null);
});
onNodesChange(handleNodesChange);
onEdgesChange(handleEdgesChange);

/**
 * IR → 画布的单向同步。
 *
 * 只更新位置与 data，不重建整批节点：重建会让正在拖拽的节点跳回原位，
 * 也会把 Vue Flow 内部的选中/悬停状态清掉。
 */
function syncFromIR(): void {
  const ir = project.ir;
  if (ir === null) return;
  const next = toFlowNodes(ir, ui.portMode);
  const nextIds = new Set(next.map((n) => n.id));

  for (const node of getNodes.value) {
    if (!nextIds.has(node.id)) removeNodes([node.id]);
  }
  for (const node of next) {
    const existing = findNode(node.id);
    if (existing === undefined) {
      addNodes([node]);
    } else {
      updateNode(node.id, { position: node.position, data: node.data, type: node.type });
    }
  }

  const nextEdges = toFlowEdges(ir);
  const nextEdgeIds = new Set(nextEdges.map((e) => e.id));
  for (const edge of getEdges.value) {
    if (!nextEdgeIds.has(edge.id)) removeEdges([edge.id]);
  }
  for (const edge of nextEdges) {
    const existing = getEdges.value.find((e) => e.id === edge.id);
    if (existing === undefined) {
      addEdges([edge]);
    } else if (
      existing.source !== edge.source ||
      existing.target !== edge.target ||
      existing.sourceHandle !== edge.sourceHandle ||
      existing.targetHandle !== edge.targetHandle
    ) {
      setEdges([...getEdges.value.filter((e) => e.id !== edge.id), edge]);
    }
  }
}

watch(
  () => project.ir,
  () => {
    syncFromIR();
  },
);

watch(
  () => ui.portMode,
  () => {
    syncFromIR();
  },
);

/** 从节点库拖入时，按落点建节点 */
function handleDrop(event: DragEvent): void {
  event.preventDefault();
  const kind = event.dataTransfer?.getData('application/fsdt-node') as NodeKind | undefined;
  if (kind === undefined || kind.length === 0) return;
  const ir = project.ir;
  if (ir === null) return;
  const position = screenToFlowCoordinate({ x: event.clientX, y: event.clientY });
  const canvasId = ir.canvases[0]?.id ?? 'cv_default';
  const at = { x: Math.round(position.x), y: Math.round(position.y) };
  const offset = { x: at.x - 136, y: at.y - 20 } as const;

  const created: IRNode = (() => {
    switch (kind) {
      case 'table':
        return createTableNode({ name: '新数据表', canvasId, position: offset });
      case 'api':
        return createApiNode({ name: '新接口', canvasId, position: offset });
      case 'page':
        return createPageNode({ name: '新页面', canvasId, position: offset });
      default:
        return createNoteNode({ name: '备注', canvasId, position: offset, note: { text: '写点什么…' } });
    }
  })();

  project.mutate((draft) => {
    draft.nodes.push(created);
  });
  ui.select(created.id);
}

/** Lint 面板点条目 → 画布跟着定位过去。普通点选节点不动视口，否则整块画布会跟着抖。 */
watch(
  () => ui.focusTarget,
  (target) => {
    if (target === null) return;
    void fitView({ nodes: [target.nodeId], duration: 320, maxZoom: 1.1, padding: 3 });
  },
);

onMounted(() => {
  syncFromIR();
  void fitView({ padding: 0.25, duration: 400 });
});
</script>

<template>
  <div class="canvas" @drop="handleDrop" @dragover.prevent>
    <VueFlow
      :connection-mode="ConnectionMode.Strict"
      :delete-key-code="['Delete', 'Backspace']"
      :min-zoom="0.2"
      :max-zoom="2"
      :default-edge-options="{ type: 'default' }"
      :proximity-options="{ distance: 220, snapTo: [{ mode: 'center' }] }"
      :snap-to-grid="false"
      fit-view-on-init
      class="canvas__flow"
    >
      <template #node-table="nodeProps">
        <TableNode :data="nodeProps.data" :selected="nodeProps.selected" />
      </template>
      <template #node-api="nodeProps">
        <ApiNode :data="nodeProps.data" :selected="nodeProps.selected" />
      </template>
      <template #node-page="nodeProps">
        <PageNode :data="nodeProps.data" :selected="nodeProps.selected" />
      </template>
      <template #node-note="nodeProps">
        <NoteNode :data="nodeProps.data" :selected="nodeProps.selected" />
      </template>

      <Background :gap="16" :size="1" pattern-color="#dfe3e8" />
      <Controls position="bottom-left" :show-interactive="false" />
    </VueFlow>

    <div v-if="project.ir !== null && project.nodes.length === 0" class="canvas__empty">
      <p class="canvas__empty-title">画布还是空的</p>
      <p class="canvas__empty-hint">从左侧节点库拖一个「表」进来开始</p>
    </div>
  </div>
</template>

<style scoped>
.canvas {
  position: relative;
  flex: 1;
  min-width: 0;
  background: #fbfcfd;
}

.canvas__flow {
  width: 100%;
  height: 100%;
}

.canvas__empty {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  pointer-events: none;
  color: var(--text-muted);
}

.canvas__empty-title {
  margin: 0;
  font-size: 14px;
  color: var(--text-soft);
}

.canvas__empty-hint {
  margin: 0;
  font-size: 12px;
}

:deep(.vue-flow__attribution) {
  display: none;
}
</style>
