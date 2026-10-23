/** 界面状态与「跑一下」的动作。动作属于界面而不是 IR，所以不放进 project store。 */
import { defineStore } from 'pinia';
import { computed, ref, shallowRef } from 'vue';

import type { LintIssue, LintResult } from '@fsdt/lint';

import { api } from '@/api/client';
import type { CompileResponse, ExportResponse, GenResponse } from '@/api/client';
import { useProjectStore } from '@/stores/project';

export type BottomTab = 'lint' | 'openapi' | 'uischema' | 'gen' | 'export';

export const useUiStore = defineStore('ui', () => {
  const selectedNodeId = ref<string | null>(null);
  const selectedEdgeId = ref<string | null>(null);
  /**
   * 「把视口移过去」的请求。和 selectedNodeId 分开是因为语义不同：
   * 选中是用户点哪里就选哪里（不该动视口），跳转是「我主动要去看它」（要动）。
   * seq 让同一个节点可以被重复请求。
   */
  const focusTarget = ref<{ nodeId: string; seq: number } | null>(null);
  let focusSeq = 0;
  const bottomTab = ref<BottomTab>('lint');
  const bottomOpen = ref(true);
  const paletteOpen = ref(true);
  /** 端口模式：打开后节点渲染全部字段端口（默认只渲染前 5 个） */
  const portMode = ref(false);
  const busy = ref<string | null>(null);
  const message = ref<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);

  const lint = shallowRef<LintResult | null>(null);
  const compile = shallowRef<CompileResponse | null>(null);
  const gen = shallowRef<GenResponse | null>(null);
  const exportResult = shallowRef<ExportResponse | null>(null);

  const project = useProjectStore();

  const issues = computed<LintIssue[]>(() => lint.value?.issues ?? []);
  const errorCount = computed(() => lint.value?.stats.error ?? 0);
  const warnCount = computed(() => lint.value?.stats.warn ?? 0);
  const fixableCount = computed(() => issues.value.filter((i) => i.fix !== undefined).length);

  function notify(type: 'success' | 'error' | 'info', text: string): void {
    message.value = { type, text };
    window.setTimeout(() => {
      if (message.value?.text === text) message.value = null;
    }, 3600);
  }

  function select(nodeId: string | null): void {
    selectedNodeId.value = nodeId;
    if (nodeId !== null) selectedEdgeId.value = null;
  }

  function selectEdge(edgeId: string | null): void {
    selectedEdgeId.value = edgeId;
    if (edgeId !== null) selectedNodeId.value = null;
  }

  /** 选中并把视口移过去（Lint 面板点条目时用） */
  function focus(nodeId: string): void {
    selectedNodeId.value = nodeId;
    selectedEdgeId.value = null;
    focusSeq += 1;
    focusTarget.value = { nodeId, seq: focusSeq };
  }

  async function guard<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
    const ir = project.ir;
    if (ir === null) return null;
    busy.value = label;
    try {
      return await fn();
    } catch (err) {
      notify('error', err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      busy.value = null;
    }
  }

  async function runLint(options: { silent?: boolean } = {}): Promise<void> {
    const ir = project.ir;
    if (ir === null) return;
    const result = await guard('lint', () => api.lint(ir));
    if (result !== null) {
      lint.value = result;
      bottomTab.value = 'lint';
      bottomOpen.value = true;
      if (options.silent !== true) {
        notify(
          result.stats.error > 0 ? 'error' : 'success',
          `Lint：${String(result.stats.error)} 错误 / ${String(result.stats.warn)} 警告`,
        );
      }
    }
  }

  /**
   * 一键修复。修复后的 IR 整体替换进 store（走 replaceIR，所以可撤销），
   * 再重跑一次 Lint —— 面板上要看到「修完之后还剩什么」，而不是修之前那份。
   */
  async function runLintFix(): Promise<void> {
    const ir = project.ir;
    if (ir === null) return;
    const result = await guard('fix', () => api.lintFix(ir));
    if (result === null) return;
    if (result.applied.length === 0) {
      notify('info', result.skipped.length > 0 ? '这些问题需要手工处理' : '没有可自动修复的问题');
      return;
    }
    project.replaceIR(result.ir);
    await runLint({ silent: true });
    const tail = result.skipped.length > 0 ? `，${String(result.skipped.length)} 项需手工处理` : '';
    notify('success', `已修复 ${String(result.applied.length)} 项${tail}`);
  }

  async function runCompile(): Promise<void> {    const ir = project.ir;
    if (ir === null) return;
    const result = await guard('compile', () => api.compile(ir));
    if (result !== null) {
      compile.value = result;
      bottomTab.value = 'openapi';
      bottomOpen.value = true;
      notify('success', '契约编译完成');
    }
  }

  async function runGen(write: boolean): Promise<void> {
    const ir = project.ir;
    if (ir === null) return;
    const result = await guard('gen', () => api.gen(ir, { write }));
    if (result !== null) {
      gen.value = result;
      bottomTab.value = 'gen';
      bottomOpen.value = true;
      const count = result.targets.reduce((sum, t) => sum + t.files.length, 0);
      notify('success', write ? `已生成 ${String(result.written.length)} 个文件` : `预览 ${String(count)} 个文件`);
    }
  }

  async function runExport(format: string): Promise<void> {
    const ir = project.ir;
    if (ir === null) return;
    const result = await guard('export', () => api.export(ir, format));
    if (result !== null) {
      exportResult.value = result;
      bottomTab.value = 'export';
      bottomOpen.value = true;
    }
  }

  return {
    selectedNodeId,
    selectedEdgeId,
    focusTarget,
    bottomTab,
    bottomOpen,
    paletteOpen,
    portMode,
    busy,
    message,
    lint,
    compile,
    gen,
    exportResult,
    issues,
    errorCount,
    warnCount,
    fixableCount,
    notify,
    select,
    selectEdge,
    focus,
    runLint,
    runLintFix,
    runCompile,
    runGen,
    runExport,
  };
});
