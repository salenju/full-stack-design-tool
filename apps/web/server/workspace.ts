/**
 * 工作台的「文件模式」存储。
 *
 * 浏览器不能直接写磁盘，所以所有 IO 都走 vite 的 dev 中间件（见 plugin.ts）。
 * 这里只负责：项目在哪、怎么读、怎么存。
 *
 * 定位顺序：
 * 1. `FSDT_WEB_WORKSPACE` 环境变量（显式指定，给多项目并行用）
 * 2. 仓库根有 `design/ir.json`（和 `fsdt init` 生成的位置一致，直接复用）
 * 3. 否则用 `.fsdt/web/`（已被 .gitignore 覆盖），并种一份示例 IR 免得开局是空白画布
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { coerceToIR, createEmptyIR, loadIR, saveIR, serializeIR, computeSchemaHash } from '@fsdt/core-ir';
import type { IR } from '@fsdt/core-ir';

export interface WorkspaceInfo {
  /** 项目目录（不是仓库根） */
  root: string;
  /** design/ir.json 的绝对路径 */
  irPath: string;
  /** file = 复用仓库里的 design/；managed = 工作台自己的 .fsdt/web/ */
  mode: 'file' | 'managed';
}

export type ResolvedWorkspace = WorkspaceInfo;

function pick(repoRoot: string): WorkspaceInfo {
  const override = process.env['FSDT_WEB_WORKSPACE'];
  if (override !== undefined && override.length > 0) {
    const root = resolve(override);
    return { root, irPath: join(root, 'design', 'ir.json'), mode: 'file' };
  }
  const repoIr = join(repoRoot, 'design', 'ir.json');
  if (existsSync(repoIr)) {
    return { root: repoRoot, irPath: repoIr, mode: 'file' };
  }
  const managedRoot = join(repoRoot, '.fsdt', 'web');
  return { root: managedRoot, irPath: join(managedRoot, 'design', 'ir.json'), mode: 'managed' };
}

/** 首次打开时的种子项目：优先用仓库里的 CLI 演示 IR，读不到就建空项目 */
async function seedIr(repoRoot: string): Promise<IR> {
  const demo = join(repoRoot, 'scripts', 'demo', 'ir.json');
  if (existsSync(demo)) {
    try {
      const text = await readFile(demo, 'utf8');
      return coerceToIR(JSON.parse(text) as unknown, demo);
    } catch {
      // 种子坏了不该让工作台起不来，退回空项目
    }
  }
  return createEmptyIR({ projectName: '未命名项目' });
}

export async function ensureWorkspace(repoRoot: string): Promise<WorkspaceInfo> {
  const ws = pick(repoRoot);
  await mkdir(dirname(ws.irPath), { recursive: true });
  if (!existsSync(ws.irPath)) {
    const ir = await seedIr(repoRoot);
    await saveIR(ws.irPath, ir);
  }
  return ws;
}

export interface LoadedState {
  workspace: WorkspaceInfo;
  ir: IR;
  schemaHash: string;
  /** 磁盘上的字节数，用于顶栏展示 */
  bytes: number;
}

export async function loadState(repoRoot: string): Promise<LoadedState> {
  const ws = await ensureWorkspace(repoRoot);
  const { ir } = await loadIR(ws.irPath);
  const text = serializeIR(ir);
  return {
    workspace: ws,
    ir,
    schemaHash: computeSchemaHash(ir),
    bytes: Buffer.byteLength(text),
  };
}

export async function saveState(ws: WorkspaceInfo, raw: unknown): Promise<{ schemaHash: string; bytes: number }> {
  // 走 coerceToIR 而不是直接写：schema 校验不过就不该落盘，
  // 否则下一次 CLI 跑起来会读到一份半成品。
  const ir = coerceToIR(raw, ws.irPath);
  ir.meta.updatedAt = new Date().toISOString();
  await saveIR(ws.irPath, ir);
  const text = serializeIR(ir);
  return { schemaHash: computeSchemaHash(ir), bytes: Buffer.byteLength(text) };
}
