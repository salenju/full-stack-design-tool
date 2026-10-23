/** 与 vite 中间件通信的极薄客户端：只有 6 个端点，不值得引入 axios */
import type { IR } from '@fsdt/core-ir';
import type { LintResult } from '@fsdt/lint';

export interface WorkspaceView {
  root: string;
  irPath: string;
  mode: 'file' | 'managed';
}

export interface StateResponse {
  workspace: WorkspaceView;
  ir: IR;
  schemaHash: string;
  bytes: number;
  exportFormats: string[];
}

export interface SaveResponse {
  schemaHash: string;
  bytes: number;
  savedAt: string;
}

export interface CompileResponse {
  openapi: { json: unknown; yaml: string };
  uiSchema: { pages: unknown; enums: unknown };
  warnings: string[];
  schemaHash: string;
}

export interface GenFileView {
  path: string;
  kind: string;
  bytes: number;
  content: string;
}

export interface GenTargetView {
  id: string;
  subdir: string;
  files: GenFileView[];
}

export interface GenResponse {
  targets: GenTargetView[];
  written: string[];
  schemaHash: string;
}

export interface ExportResponse {
  format: string;
  fileName: string;
  mimeType: string;
  content?: string;
  base64?: string;
}

export interface LintFixResponse {
  ir: IR;
  applied: Array<{ ruleId: string; message: string }>;
  skipped: Array<{ ruleId: string; message: string; reason: string }>;
}

class ApiFailure extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiFailure';
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, headers: {} };
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  const text = await res.text();
  let payload: unknown = null;
  if (text.length > 0) {
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      payload = { error: text };
    }
  }
  if (!res.ok) {
    const message =
      typeof payload === 'object' && payload !== null && 'error' in payload
        ? String((payload as { error: unknown }).error)
        : `请求失败（${String(res.status)}）`;
    throw new ApiFailure(message, res.status);
  }
  return payload as T;
}

export const api = {
  state: () => request<StateResponse>('GET', '/api/state'),
  save: (ir: IR) => request<SaveResponse>('PUT', '/api/ir', { ir }),
  lint: (ir: IR) => request<LintResult & { schemaHash: string }>('POST', '/api/lint', { ir }),
  lintFix: (ir: IR) => request<LintFixResponse>('POST', '/api/lint/fix', { ir }),
  compile: (ir: IR) => request<CompileResponse>('POST', '/api/compile', { ir }),
  gen: (ir: IR, options: { targets?: string[]; write?: boolean } = {}) =>
    request<GenResponse>('POST', '/api/gen', { ir, ...options }),
  export: (ir: IR, format: string) => request<ExportResponse>('POST', '/api/export', { ir, format }),
};

export { ApiFailure };
