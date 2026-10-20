/**
 * IR 的单一持有者。
 *
 * 三条纪律，和画布、检查器都有关系：
 * 1. **所有变更走 `mutate`**，否则撤销栈会漏掉这一步，用户按 Ctrl+Z 会跳回很久以前。
 * 2. **IR 是不可变替换**（`mutate` 里深拷贝再改），而不是原地改字段。
 *    原地改的话，撤销栈里存的是同一个引用，撤销等于没撤。
 * 3. **拖动过程不写回**。节点在拖的时候只动 Vue Flow 的本地坐标，
 *    松手（dragstop）才提交一步——否则一次拖动会塞进几十个撤销步骤。
 */
import { defineStore } from 'pinia';
import { computed, ref, shallowRef } from 'vue';

import type { IR, IRNode } from '@fsdt/core-ir';

import { api } from '@/api/client';
import type { StateResponse, WorkspaceView } from '@/api/client';

const UNDO_LIMIT = 60;
const AUTOSAVE_DELAY = 800;

export type SaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

function clone<T>(value: T): T {
  return structuredClone(value);
}

export const useProjectStore = defineStore('project', () => {
  const ir = shallowRef<IR | null>(null);
  const workspace = shallowRef<WorkspaceView | null>(null);
  const schemaHash = ref('');
  const bytes = ref(0);
  const status = ref<SaveStatus>('idle');
  const error = ref<string | null>(null);
  const lastSavedAt = ref<string | null>(null);
  const loading = ref(false);

  // 撤销栈不放进响应式系统：快照可能是几百 KB 的 IR，让 Vue 深度代理它们纯属浪费
  let undoStack: IR[] = [];
  let redoStack: IR[] = [];
  const undoDepth = ref(0);
  const redoDepth = ref(0);

  let saveTimer: ReturnType<typeof setTimeout> | undefined;

  const nodes = computed<IRNode[]>(() => ir.value?.nodes ?? []);
  const canvas = computed(() => ir.value?.canvases[0] ?? null);

  function syncDepth(): void {
    undoDepth.value = undoStack.length;
    redoDepth.value = redoStack.length;
  }

  async function load(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      const state: StateResponse = await api.state();
      ir.value = state.ir;
      workspace.value = state.workspace;
      schemaHash.value = state.schemaHash;
      bytes.value = state.bytes;
      undoStack = [];
      redoStack = [];
      syncDepth();
      status.value = 'idle';
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
      status.value = 'error';
    } finally {
      loading.value = false;
    }
  }

  /** 唯一的变更入口 */
  function mutate(fn: (draft: IR) => void): void {
    const current = ir.value;
    if (current === null) return;
    const draft = clone(current);
    fn(draft);
    draft.meta.updatedAt = new Date().toISOString();
    undoStack.push(current);
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    redoStack = [];
    ir.value = draft;
    syncDepth();
    scheduleSave();
  }

  function undo(): void {
    const prev = undoStack.pop();
    if (prev === undefined) return;
    const current = ir.value;
    if (current !== null) redoStack.push(current);
    ir.value = prev;
    syncDepth();
    scheduleSave();
  }

  function redo(): void {
    const next = redoStack.pop();
    if (next === undefined) return;
    const current = ir.value;
    if (current !== null) undoStack.push(current);
    ir.value = next;
    syncDepth();
    scheduleSave();
  }

  function scheduleSave(): void {
    status.value = 'dirty';
    if (saveTimer !== undefined) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      void save();
    }, AUTOSAVE_DELAY);
  }

  async function save(): Promise<void> {
    if (ir.value === null) return;
    if (saveTimer !== undefined) {
      clearTimeout(saveTimer);
      saveTimer = undefined;
    }
    status.value = 'saving';
    try {
      const result = await api.save(ir.value);
      schemaHash.value = result.schemaHash;
      bytes.value = result.bytes;
      lastSavedAt.value = result.savedAt;
      status.value = 'saved';
      error.value = null;
    } catch (err) {
      status.value = 'error';
      error.value = err instanceof Error ? err.message : String(err);
    }
  }

  /** 整体替换（导入 JSON / 重新载入磁盘） */
  function replaceIR(next: IR, options: { keepHistory?: boolean } = {}): void {
    const current = ir.value;
    if (current !== null && options.keepHistory !== false) {
      undoStack.push(current);
      redoStack = [];
      syncDepth();
    }
    ir.value = next;
    scheduleSave();
  }

  function projectName(): string {
    return ir.value?.project.name ?? '未命名项目';
  }

  return {
    ir,
    workspace,
    schemaHash,
    bytes,
    status,
    error,
    lastSavedAt,
    loading,
    nodes,
    canvas,
    undoDepth,
    redoDepth,
    load,
    save,
    mutate,
    undo,
    redo,
    replaceIR,
    projectName,
  };
});
