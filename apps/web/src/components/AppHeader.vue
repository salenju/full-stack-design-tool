<script setup lang="ts">
import { computed, ref } from 'vue';

import { coerceToIR, serializeIR } from '@fsdt/core-ir';

import { useProjectStore } from '@/stores/project';
import { useUiStore } from '@/stores/ui';

const project = useProjectStore();
const ui = useUiStore();

const fileInput = ref<HTMLInputElement | null>(null);

const statusText = computed(() => {
  switch (project.status) {
    case 'idle':
      return '已加载';
    case 'dirty':
      return '未保存';
    case 'saving':
      return '保存中…';
    case 'saved':
      return project.lastSavedAt === null ? '已保存' : `已保存 ${new Date(project.lastSavedAt).toLocaleTimeString('zh-CN', { hour12: false })}`;
    case 'error':
      return '保存失败';
    default:
      return '';
  }
});

function setProjectName(value: string): void {
  const name = value.trim();
  if (name.length === 0 || name === project.ir?.project.name) return;
  project.mutate((draft) => {
    draft.project.name = name;
  });
}

function exportJson(): void {
  const ir = project.ir;
  if (ir === null) return;
  const blob = new Blob([serializeIR(ir)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'ir.json';
  a.click();
  URL.revokeObjectURL(url);
  ui.notify('success', '已导出 ir.json');
}

async function importJson(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file === undefined) return;
  try {
    const text = await file.text();
    const ir = coerceToIR(JSON.parse(text) as unknown, file.name);
    project.replaceIR(ir);
    ui.notify('success', `已导入 ${file.name}`);
  } catch (err) {
    ui.notify('error', `导入失败：${err instanceof Error ? err.message : String(err)}`);
  } finally {
    input.value = '';
  }
}
</script>

<template>
  <header class="bar">
    <div class="bar__brand">
      <span class="bar__logo">fsdt</span>
      <input
        class="bar__name"
        :value="project.ir?.project.name ?? '加载中…'"
        spellcheck="false"
        @change="setProjectName(($event.target as HTMLInputElement).value)"
      />
    </div>

    <div class="bar__status">
      <span class="dot" :data-status="project.status" />
      <span class="bar__status-text">{{ statusText }}</span>
      <span class="bar__hash" :title="project.schemaHash">{{ project.schemaHash.slice(0, 10) }}</span>
    </div>

    <div class="bar__group">
      <button
        class="btn"
        type="button"
        :disabled="project.undoDepth === 0"
        title="撤销（Ctrl/Cmd + Z）"
        @click="project.undo()"
      >
        撤销<span v-if="project.undoDepth > 0" class="btn__count">{{ project.undoDepth }}</span>
      </button>
      <button
        class="btn"
        type="button"
        :disabled="project.redoDepth === 0"
        title="重做（Ctrl/Cmd + Shift + Z）"
        @click="project.redo()"
      >
        重做<span v-if="project.redoDepth > 0" class="btn__count">{{ project.redoDepth }}</span>
      </button>
    </div>

    <div class="bar__group">
      <button class="btn" type="button" :disabled="ui.busy !== null" @click="ui.runLint()">Lint</button>
      <button class="btn" type="button" :disabled="ui.busy !== null" @click="ui.runCompile()">编译契约</button>
      <button class="btn" type="button" :disabled="ui.busy !== null" @click="ui.runGen(false)">预览生成</button>
      <button class="btn btn--primary" type="button" :disabled="ui.busy !== null" @click="ui.runGen(true)">
        生成到 output
      </button>
      <el-dropdown trigger="click" @command="(format: string) => ui.runExport(format)">
        <button class="btn" type="button">导出画布 ▾</button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="svg">SVG</el-dropdown-item>
            <el-dropdown-item command="png">PNG</el-dropdown-item>
            <el-dropdown-item command="mermaid">Mermaid</el-dropdown-item>
            <el-dropdown-item command="drawio">draw.io</el-dropdown-item>
            <el-dropdown-item command="json">JSON</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </div>

    <div class="bar__group bar__group--right">
      <button class="btn" type="button" @click="fileInput?.click()">导入 JSON</button>
      <button class="btn" type="button" @click="exportJson">导出 JSON</button>
      <button class="btn" type="button" :disabled="project.status === 'saving'" @click="project.save()">
        立即保存
      </button>
      <input ref="fileInput" type="file" accept="application/json,.json" hidden @change="importJson" />
    </div>

    <transition name="fade">
      <div v-if="ui.message !== null" class="toast" :data-type="ui.message.type">{{ ui.message.text }}</div>
    </transition>
  </header>
</template>

<style scoped>
.bar {
  position: relative;
  display: flex;
  align-items: center;
  gap: 14px;
  height: 44px;
  padding: 0 12px;
  background: var(--panel);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.bar__brand {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.bar__logo {
  font-family: var(--mono);
  font-size: 12px;
  font-weight: 700;
  color: #fff;
  background: var(--accent);
  border-radius: 5px;
  padding: 2px 6px;
  letter-spacing: 0.02em;
}

.bar__name {
  border: 1px solid transparent;
  background: transparent;
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  padding: 3px 6px;
  border-radius: 5px;
  width: 168px;
  outline: none;
}

.bar__name:hover {
  border-color: var(--border);
}

.bar__name:focus {
  border-color: var(--accent);
  background: #fff;
}

.bar__status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-muted);
  flex-shrink: 0;
}

.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #cbd5e1;
}

.dot[data-status='dirty'] {
  background: #f59e0b;
}

.dot[data-status='saving'] {
  background: #3b82f6;
}

.dot[data-status='saved'] {
  background: #10b981;
}

.dot[data-status='error'] {
  background: #ef4444;
}

.bar__status-text {
  min-width: 62px;
}

.bar__hash {
  font-family: var(--mono);
  font-size: 9.5px;
  color: var(--text-muted);
  background: #f2f4f7;
  border-radius: 3px;
  padding: 0 4px;
}

.bar__group {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.bar__group--right {
  margin-left: auto;
}

.btn {
  border: 1px solid var(--border);
  background: #fff;
  border-radius: 6px;
  padding: 4px 9px;
  font-size: 11.5px;
  color: var(--text-soft);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  transition: border-color 0.15s ease, background 0.15s ease, color 0.15s ease;
  white-space: nowrap;
}

.btn:hover:not(:disabled) {
  border-color: var(--border-strong);
  color: var(--text);
  background: #fcfcfd;
}

.btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.btn--primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}

.btn--primary:hover:not(:disabled) {
  background: #4338ca;
  border-color: #4338ca;
  color: #fff;
}

.btn__count {
  font-size: 9px;
  background: #f2f4f7;
  border-radius: 999px;
  padding: 0 4px;
  color: var(--text-muted);
}

.toast {
  position: absolute;
  left: 50%;
  top: 50px;
  transform: translateX(-50%);
  z-index: 30;
  background: #101828;
  color: #fff;
  font-size: 11.5px;
  border-radius: 7px;
  padding: 7px 13px;
  box-shadow: var(--shadow-md);
  max-width: 60%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.toast[data-type='error'] {
  background: #b42318;
}

.toast[data-type='success'] {
  background: #027a48;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
  transform: translate(-50%, -4px);
}
</style>
