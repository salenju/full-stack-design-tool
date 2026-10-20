<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue';

import AppHeader from '@/components/AppHeader.vue';
import BottomPanel from '@/components/BottomPanel.vue';
import NodePalette from '@/components/NodePalette.vue';
import CanvasView from '@/components/canvas/CanvasView.vue';
import InspectorPanel from '@/components/inspector/InspectorPanel.vue';
import { useProjectStore } from '@/stores/project';
import { useUiStore } from '@/stores/ui';

const project = useProjectStore();
const ui = useUiStore();

/** 在输入控件里按 Ctrl+Z 应该撤销文本，而不是撤销整个 IR */
function isEditingText(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || target.isContentEditable;
}

function onKeydown(event: KeyboardEvent): void {
  const meta = event.metaKey || event.ctrlKey;
  if (!meta) return;

  if (event.key.toLowerCase() === 's') {
    event.preventDefault();
    void project.save();
    return;
  }
  if (isEditingText(event.target)) return;

  if (event.key.toLowerCase() === 'z') {
    event.preventDefault();
    if (event.shiftKey) project.redo();
    else project.undo();
  }
}

onMounted(() => {
  void project.load().then(() => {
    // 打开就顺手跑一次 Lint：面板空着会让人以为「没检查」，而这一步只要几毫秒
    if (project.ir !== null) void ui.runLint({ silent: true });
  });
  window.addEventListener('keydown', onKeydown);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown);
});
</script>

<template>
  <div class="app">
    <AppHeader />

    <div v-if="project.error !== null && project.ir === null" class="app__error">
      <p class="app__error-title">加载失败</p>
      <p class="app__error-text">{{ project.error }}</p>
      <p class="app__error-hint">检查 design/ir.json 是否存在且是合法 IR，或看终端里 vite 的输出。</p>
      <el-button size="small" @click="project.load()">重试</el-button>
    </div>

    <div v-else class="app__main">
      <NodePalette />
      <CanvasView />
      <InspectorPanel />
    </div>

    <BottomPanel />
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.app__main {
  flex: 1;
  min-height: 0;
  display: flex;
}

.app__error {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  color: var(--text-soft);
}

.app__error-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: #b42318;
}

.app__error-text {
  margin: 0;
  font-size: 12px;
  max-width: 620px;
  text-align: center;
  line-height: 1.6;
}

.app__error-hint {
  margin: 0 0 8px;
  font-size: 11px;
  color: var(--text-muted);
}
</style>
