<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';

import type { LintSeverity } from '@fsdt/lint';

import { useProjectStore } from '@/stores/project';
import { useUiStore } from '@/stores/ui';

const project = useProjectStore();
const ui = useUiStore();

const openapiFormat = ref<'yaml' | 'json'>('yaml');
const activeFile = ref<string | null>(null);

/** 面板高度可拖，看 OpenAPI 时经常需要更大的地方 */
const height = ref(260);
let dragStart: { y: number; height: number } | null = null;

function onDragStart(event: MouseEvent): void {
  dragStart = { y: event.clientY, height: height.value };
  window.addEventListener('mousemove', onDragMove);
  window.addEventListener('mouseup', onDragEnd);
  event.preventDefault();
}

function onDragMove(event: MouseEvent): void {
  if (dragStart === null) return;
  const next = dragStart.height + (dragStart.y - event.clientY);
  const max = Math.round(window.innerHeight * 0.72);
  height.value = Math.min(Math.max(next, 120), max);
}

function onDragEnd(): void {
  dragStart = null;
  window.removeEventListener('mousemove', onDragMove);
  window.removeEventListener('mouseup', onDragEnd);
}

onBeforeUnmount(onDragEnd);

const tabs = computed(() => [
  { key: 'lint' as const, label: `Lint`, badge: ui.issues.length > 0 ? String(ui.issues.length) : '' },
  { key: 'openapi' as const, label: 'OpenAPI', badge: '' },
  { key: 'uischema' as const, label: 'UI Schema', badge: '' },
  {
    key: 'gen' as const,
    label: '生成产物',
    badge: ui.gen === null ? '' : String(ui.gen.targets.reduce((s, t) => s + t.files.length, 0)),
  },
  { key: 'export' as const, label: '导出', badge: '' },
]);

const SEVERITY_CLASS: Record<LintSeverity, string> = {
  error: 'sev--error',
  warn: 'sev--warn',
  info: 'sev--info',
};

const SEVERITY_LABEL: Record<LintSeverity, string> = {
  error: '错误',
  warn: '警告',
  info: '提示',
};

const openapiText = computed(() => {
  const doc = ui.compile?.openapi;
  if (doc === undefined) return '';
  return openapiFormat.value === 'json' ? JSON.stringify(doc.json, null, 2) : doc.yaml;
});

const uiSchemaText = computed(() => {
  const ui_ = ui.compile?.uiSchema;
  if (ui_ === undefined) return '';
  return JSON.stringify(ui_, null, 2);
});

const allFiles = computed(() => {
  if (ui.gen === null) return [];
  return ui.gen.targets.flatMap((t) => t.files.map((f) => ({ ...f, target: t.id })));
});

const activeContent = computed(() => {
  if (activeFile.value === null) return '';
  return allFiles.value.find((f) => f.path === activeFile.value)?.content ?? '';
});

watch(allFiles, (files) => {
  if (activeFile.value === null && files.length > 0) activeFile.value = files[0]?.path ?? null;
});

function gotoIssue(nodeId: string | undefined): void {
  if (nodeId === undefined) return;
  ui.focus(nodeId);
}

function download(): void {
  const result = ui.exportResult;
  if (result === null) return;
  const blob =
    result.base64 !== undefined
      ? new Blob([Uint8Array.from(atob(result.base64), (c) => c.charCodeAt(0))], { type: result.mimeType })
      : new Blob([result.content ?? ''], { type: result.mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = result.fileName;
  a.click();
  URL.revokeObjectURL(url);
}

function copy(text: string): void {
  void navigator.clipboard.writeText(text).then(() => {
    ui.notify('success', '已复制到剪贴板');
  });
}
</script>

<template>
  <section
    class="bottom"
    :class="{ 'bottom--collapsed': !ui.bottomOpen }"
    :style="{ height: ui.bottomOpen ? `${height}px` : 'auto' }"
  >
    <div v-if="ui.bottomOpen" class="bottom__grip" title="拖动调整高度" @mousedown="onDragStart" />
    <header class="bottom__head">
      <div class="bottom__tabs">
        <button
          v-for="tab in tabs"
          :key="tab.key"
          type="button"
          class="bottom__tab"
          :class="{ 'bottom__tab--on': ui.bottomTab === tab.key }"
          @click="
            ui.bottomTab = tab.key;
            ui.bottomOpen = true;
          "
        >
          {{ tab.label }}
          <span v-if="tab.badge !== ''" class="bottom__badge">{{ tab.badge }}</span>
        </button>
      </div>

      <div class="bottom__actions">
        <span v-if="ui.busy !== null" class="bottom__busy">正在跑 {{ ui.busy }}…</span>
        <button class="bottom__collapse" type="button" @click="ui.bottomOpen = !ui.bottomOpen">
          {{ ui.bottomOpen ? '收起' : '展开' }}
        </button>
      </div>
    </header>

    <div v-if="ui.bottomOpen" class="bottom__body">
      <!-- Lint -->
      <div v-if="ui.bottomTab === 'lint'" class="pane">
        <div v-if="ui.lint === null" class="pane__empty">
          还没跑过 Lint。<button class="link" type="button" @click="ui.runLint()">现在跑一次</button>
        </div>
        <template v-else>
          <div class="lint__stats">
            <span class="stat stat--error">{{ ui.lint.stats.error }} 错误</span>
            <span class="stat stat--warn">{{ ui.lint.stats.warn }} 警告</span>
            <span class="stat stat--info">{{ ui.lint.stats.info }} 提示</span>
            <span v-if="ui.lint.blocked" class="stat stat--blocked">会阻断 CI</span>
            <span v-if="ui.lint.ignored.length > 0" class="stat">已忽略 {{ ui.lint.ignored.length }}</span>
          </div>
          <div v-if="ui.issues.length === 0" class="pane__empty">没有发现问题。</div>
          <div v-else class="lint__list">
            <button
              v-for="(issue, index) in ui.issues"
              :key="`${issue.ruleId}-${String(index)}`"
              type="button"
              class="lint__row"
              :class="SEVERITY_CLASS[issue.severity]"
              @click="gotoIssue(issue.target.nodeId)"
            >
              <span class="lint__sev">{{ SEVERITY_LABEL[issue.severity] }}</span>
              <span class="lint__rule">{{ issue.ruleId }}</span>
              <span class="lint__msg">{{ issue.message }}</span>
              <span v-if="issue.fix !== undefined" class="lint__fix">可自动修复</span>
            </button>
          </div>
        </template>
      </div>

      <!-- OpenAPI -->
      <div v-else-if="ui.bottomTab === 'openapi'" class="pane">
        <div v-if="ui.compile === null" class="pane__empty">
          还没编译过。<button class="link" type="button" @click="ui.runCompile()">编译契约</button>
        </div>
        <template v-else>
          <div class="pane__bar">
            <el-radio-group v-model="openapiFormat" size="small">
              <el-radio-button value="yaml">YAML</el-radio-button>
              <el-radio-button value="json">JSON</el-radio-button>
            </el-radio-group>
            <button class="link" type="button" @click="copy(openapiText)">复制</button>
            <span v-if="ui.compile.warnings.length > 0" class="pane__warn">
              编译警告 {{ ui.compile.warnings.length }} 条
            </span>
          </div>
          <pre class="code">{{ openapiText }}</pre>
        </template>
      </div>

      <!-- UI Schema -->
      <div v-else-if="ui.bottomTab === 'uischema'" class="pane">
        <div v-if="ui.compile === null" class="pane__empty">
          还没编译过。<button class="link" type="button" @click="ui.runCompile()">编译 UI Schema</button>
        </div>
        <template v-else>
          <div class="pane__bar">
            <span class="pane__meta">页面生成器的输入，Vue 生成器只读这一层</span>
            <button class="link" type="button" @click="copy(uiSchemaText)">复制</button>
          </div>
          <pre class="code">{{ uiSchemaText }}</pre>
        </template>
      </div>

      <!-- 生成产物 -->
      <div v-else-if="ui.bottomTab === 'gen'" class="pane">
        <div v-if="ui.gen === null" class="pane__empty">
          还没生成过。<button class="link" type="button" @click="ui.runGen(false)">预览生成结果</button>
        </div>
        <div v-else class="gen">
          <div class="gen__list">
            <div v-for="target in ui.gen.targets" :key="target.id" class="gen__group">
              <div class="gen__group-title">{{ target.id }} · {{ target.files.length }} 文件</div>
              <button
                v-for="file in target.files"
                :key="file.path"
                type="button"
                class="gen__file"
                :class="{ 'gen__file--on': activeFile === file.path }"
                @click="activeFile = file.path"
              >
                <span class="gen__kind">{{ file.kind }}</span>
                <span class="gen__path">{{ file.path }}</span>
              </button>
            </div>
          </div>
          <pre class="code gen__preview">{{ activeContent }}</pre>
        </div>
      </div>

      <!-- 导出 -->
      <div v-else class="pane">
        <div v-if="ui.exportResult === null" class="pane__empty">
          选一个格式导出画布：
          <button class="link" type="button" @click="ui.runExport('svg')">SVG</button>
          <button class="link" type="button" @click="ui.runExport('png')">PNG</button>
          <button class="link" type="button" @click="ui.runExport('mermaid')">Mermaid</button>
          <button class="link" type="button" @click="ui.runExport('json')">JSON</button>
        </div>
        <template v-else>
          <div class="pane__bar">
            <span class="pane__meta">{{ ui.exportResult.fileName }}</span>
            <button class="link" type="button" @click="download">下载</button>
            <button class="link" type="button" @click="ui.runExport('mermaid')">Mermaid</button>
            <button class="link" type="button" @click="ui.runExport('svg')">SVG</button>
          </div>
          <div v-if="ui.exportResult.format === 'svg' && ui.exportResult.content !== undefined" class="svg-wrap">
            <div class="svg-box" v-html="ui.exportResult.content" />
          </div>
          <pre v-else class="code">{{ ui.exportResult.content ?? `（${ui.exportResult.format} 二进制）` }}</pre>
        </template>
      </div>
    </div>
  </section>
</template>

<style scoped>
.bottom {
  border-top: 1px solid var(--border);
  background: var(--panel);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  position: relative;
}

.bottom__grip {
  position: absolute;
  top: -3px;
  left: 0;
  right: 0;
  height: 6px;
  cursor: ns-resize;
  z-index: 5;
}

.bottom__grip:hover {
  background: rgba(79, 70, 229, 0.18);
}

.bottom__head {
  display: flex;
  align-items: center;
  padding: 0 10px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
  min-height: 32px;
}

.bottom__tabs {
  display: flex;
  gap: 2px;
  flex: 1;
}

.bottom__tab {
  border: none;
  background: transparent;
  padding: 7px 10px;
  font-size: 11.5px;
  color: var(--text-muted);
  cursor: pointer;
  border-bottom: 2px solid transparent;
  display: flex;
  align-items: center;
  gap: 4px;
}

.bottom__tab:hover {
  color: var(--text);
}

.bottom__tab--on {
  color: var(--accent);
  border-bottom-color: var(--accent);
  font-weight: 600;
}

.bottom__badge {
  background: #f2f4f7;
  border-radius: 999px;
  padding: 0 5px;
  font-size: 9.5px;
  color: var(--text-soft);
}

.bottom__actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.bottom__busy {
  font-size: 10.5px;
  color: var(--accent);
}

.bottom__collapse {
  border: 1px solid var(--border);
  background: #fff;
  border-radius: 5px;
  padding: 2px 8px;
  font-size: 10.5px;
  color: var(--text-soft);
  cursor: pointer;
}

.bottom__body {
  flex: 1;
  min-height: 0;
  display: flex;
}

.pane {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.pane__empty {
  padding: 18px;
  font-size: 11.5px;
  color: var(--text-muted);
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}

.pane__bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.pane__meta {
  font-size: 10.5px;
  color: var(--text-muted);
  flex: 1;
}

.pane__warn {
  font-size: 10.5px;
  color: #b45309;
}

.link {
  border: none;
  background: transparent;
  color: var(--accent);
  font-size: 11px;
  cursor: pointer;
  padding: 0;
}

.link:hover {
  text-decoration: underline;
}

.lint__stats {
  display: flex;
  gap: 10px;
  padding: 7px 12px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.stat {
  font-size: 10.5px;
  color: var(--text-soft);
}

.stat--error {
  color: #dc2626;
}

.stat--warn {
  color: #d97706;
}

.stat--info {
  color: #2563eb;
}

.stat--blocked {
  color: #fff;
  background: #dc2626;
  border-radius: 3px;
  padding: 0 5px;
}

.lint__list {
  overflow-y: auto;
  flex: 1;
}

.lint__row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  text-align: left;
  border: none;
  background: transparent;
  padding: 5px 12px;
  border-bottom: 1px solid #f5f6f8;
  cursor: pointer;
  font-size: 11.5px;
}

.lint__row:hover {
  background: #f8fafc;
}

.lint__sev {
  width: 30px;
  flex-shrink: 0;
  font-size: 10px;
}

.sev--error .lint__sev {
  color: #dc2626;
}

.sev--warn .lint__sev {
  color: #d97706;
}

.sev--info .lint__sev {
  color: #2563eb;
}

.lint__rule {
  font-family: var(--mono);
  font-size: 10px;
  color: var(--text-muted);
  width: 34px;
  flex-shrink: 0;
}

.lint__msg {
  flex: 1;
  color: var(--text-soft);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lint__fix {
  font-size: 9.5px;
  color: #4f46e5;
  background: #eef2ff;
  border-radius: 3px;
  padding: 0 4px;
  flex-shrink: 0;
}

.code {
  margin: 0;
  padding: 10px 12px;
  overflow: auto;
  font-size: 10.5px;
  line-height: 1.62;
  color: #334155;
  background: #fbfcfd;
  flex: 1;
  white-space: pre;
}

.gen {
  display: flex;
  flex: 1;
  min-height: 0;
}

.gen__list {
  width: 280px;
  border-right: 1px solid var(--border);
  overflow-y: auto;
  flex-shrink: 0;
}

.gen__group-title {
  padding: 6px 10px 3px;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-muted);
}

.gen__file {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  border: none;
  background: transparent;
  padding: 3px 10px;
  cursor: pointer;
  text-align: left;
}

.gen__file:hover {
  background: #f8fafc;
}

.gen__file--on {
  background: var(--accent-soft);
}

.gen__kind {
  font-size: 9px;
  color: var(--text-muted);
  background: #f2f4f7;
  border-radius: 3px;
  padding: 0 4px;
  flex-shrink: 0;
}

.gen__path {
  font-family: var(--mono);
  font-size: 10px;
  color: var(--text-soft);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.gen__preview {
  flex: 1;
  min-width: 0;
}

.svg-wrap {
  flex: 1;
  overflow: auto;
  padding: 12px;
  background: #f8fafc;
}

.svg-box :deep(svg) {
  max-width: 100%;
  height: auto;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 6px;
}
</style>
