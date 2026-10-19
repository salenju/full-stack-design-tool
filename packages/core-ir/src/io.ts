/**
 * IR 文件读写（文件模式）。
 *
 * 设计要点（技术设计 5.2 / 16.5）：
 * - **文件模式**：IR 存仓库内（如 `design/ir.json`），由 git 管理，CI 可见。
 * - **服务模式**：IR 存 `~/.fsdt/projects/<id>/canvases/*.ir.json`。
 * 两者共用本模块的「读 → 迁移 → 校验」流程，只是路径不同。
 *
 * 读文件时若发现低版本，会自动迁移并先把原文件备份成 `<name>.v<N>.bak.json`。
 * 绝不静默覆盖用户数据——这是唯一不可妥协的一条。
 */

import { readFile, writeFile, mkdir, copyFile, access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { migrateToCurrent } from './migrations.js';
import { irSchema } from './schema.js';
import type { Diagnostic } from './diagnostics.js';
import type { IR } from './types.js';

export class IRFileError extends Error {
  constructor(
    message: string,
    readonly code: 'ENOENT' | 'PARSE' | 'SCHEMA' | 'UNSUPPORTED' | 'IO',
    readonly details?: unknown,
    readonly diagnostics?: Diagnostic[],
  ) {
    super(message);
    this.name = 'IRFileError';
  }
}

export interface LoadIROptions {
  /** 迁移前把原文件备份到 `<path>.v<N>.bak.json`，默认 true */
  backupBeforeMigrate?: boolean;
  /** 迁移了就不校验（排查问题时可跳过），默认 false */
  skipValidation?: boolean;
}

export interface LoadIRResult {
  ir: IR;
  /** 实际读取的绝对路径 */
  path: string;
  /** 应用过的迁移（空数组表示无需迁移） */
  migrated: number[];
  /** 迁移备份文件路径 */
  backupPath?: string;
}

/** 从字符串解析 IR（不含文件 IO，便于测试与 HTTP body 使用） */
export function parseIR(text: string, source = '<string>'): IR {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new IRFileError(`IR 不是合法 JSON（${source}）`, 'PARSE', err);
  }
  return coerceToIR(raw, source);
}

/** 从已解析对象得到当前版本且合法的 IR */
export function coerceToIR(raw: unknown, source = '<object>'): IR {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new IRFileError(`IR 顶层必须是对象（${source}）`, 'SCHEMA');
  }

  let migrated: unknown;
  try {
    migrated = migrateToCurrent(raw as Record<string, unknown>).ir;
  } catch (err) {
    if (err instanceof Error && err.name === 'UnsupportedSchemaVersionError') {
      throw new IRFileError(err.message, 'UNSUPPORTED', err);
    }
    throw err;
  }

  const parsed = irSchema.safeParse(migrated);
  if (!parsed.success) {
    const diagnostics: Diagnostic[] = parsed.error.issues.map((issue) => ({
      code: 'IR000',
      severity: 'error',
      message: `${issue.path.join('.') || '<root>'}：${issue.message}`,
      target: {},
    }));
    const preview = diagnostics
      .slice(0, 8)
      .map((d) => `  • ${d.message}`)
      .join('\n');
    const more = diagnostics.length > 8 ? `\n  …共 ${diagnostics.length} 个问题` : '';
    throw new IRFileError(`IR 结构校验失败（${source}）：\n${preview}${more}`, 'SCHEMA', parsed.error, diagnostics);
  }

  return parsed.data as IR;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** 读取 IR 文件，自动备份 + 迁移 + 校验 */
export async function loadIR(path: string, options: LoadIROptions = {}): Promise<LoadIRResult> {
  const abs = resolve(path);
  let text: string;
  try {
    text = await readFile(abs, 'utf8');
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      throw new IRFileError(`IR 文件不存在：${abs}`, 'ENOENT', err);
    }
    throw new IRFileError(`读取 IR 失败：${abs}：${e.message}`, 'IO', err);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new IRFileError(`IR 不是合法 JSON：${abs}`, 'PARSE', err);
  }

  const sourceVersion =
    raw !== null && typeof raw === 'object' && typeof (raw as { schemaVersion?: unknown }).schemaVersion === 'number'
      ? (raw as { schemaVersion: number }).schemaVersion
      : undefined;

  let migratedIR: unknown;
  let applied: ReturnType<typeof migrateToCurrent>['applied'];
  try {
    const result = migrateToCurrent(raw as Record<string, unknown>);
    migratedIR = result.ir;
    applied = result.applied;
  } catch (err) {
    // 与 coerceToIR 保持同一套错误分类：版本不认识是 UNSUPPORTED 而不是裸抛
    if (err instanceof Error && err.name === 'UnsupportedSchemaVersionError') {
      throw new IRFileError(err.message, 'UNSUPPORTED', err);
    }
    throw err;
  }

  let backupPath: string | undefined;
  if (applied.length > 0 && (options.backupBeforeMigrate ?? true) && sourceVersion !== undefined) {
    backupPath = `${abs}.v${sourceVersion}.bak.json`;
    await copyFile(abs, backupPath);
  }

  // 迁移后的对象仍要走完整 schema + 语义校验（迁移函数可能出错）
  const validated = options.skipValidation === true ? (migratedIR as unknown as IR) : coerceToIR(migratedIR, abs);

  return {
    ir: validated,
    path: abs,
    migrated: applied.map((m) => m.to),
    ...(backupPath !== undefined ? { backupPath } : {}),
  };
}

export interface SaveIROptions {
  /** 缩进，默认 2（便于 git diff） */
  indent?: number;
  /** 原子写：先写 .tmp 再 rename，默认 true */
  atomic?: boolean;
  /** 写前跑语义校验，有 error 则拒绝写入，默认 true */
  validate?: boolean;
}

/** 写入 IR 文件（父目录自动创建；默认原子写 + 校验） */
export async function saveIR(path: string, ir: IR, options: SaveIROptions = {}): Promise<string> {
  const abs = resolve(path);
  const indent = options.indent ?? 2;

  if (options.validate ?? true) {
    // 延迟 import，避免 core-ir 内部循环依赖
    const { validateIR } = await import('./validate.js');
    const errors = validateIR(ir).filter((d) => d.severity === 'error');
    if (errors.length > 0) {
      const detail = errors
        .slice(0, 8)
        .map((d) => `  • [${d.code}] ${d.message}`)
        .join('\n');
      throw new IRFileError(
        `拒绝写入非法 IR（${errors.length} 个错误）：\n${detail}`,
        'SCHEMA',
        undefined,
        errors,
      );
    }
  }

  const text = JSON.stringify(ir, null, indent) + '\n';
  await mkdir(dirname(abs), { recursive: true });

  if (options.atomic ?? true) {
    const tmp = `${abs}.${process.pid}.tmp`;
    await writeFile(tmp, text, 'utf8');
    // rename 在同一文件系统内是原子的；跨设备时会失败，降级为直接覆盖
    try {
      const { rename } = await import('node:fs/promises');
      await rename(tmp, abs);
    } catch {
      await writeFile(abs, text, 'utf8');
      const { unlink } = await import('node:fs/promises');
      await unlink(tmp).catch(() => undefined);
    }
  } else {
    await writeFile(abs, text, 'utf8');
  }

  return abs;
}

/** 判断某路径是否已存在（供 CLI 的 `init` 做「已存在则不覆盖」判断） */
export { exists as pathExists };

/** 把 IR 序列化为字符串（不落盘，供 HTTP 响应与测试使用） */
export function serializeIR(ir: IR, indent = 2): string {
  return JSON.stringify(ir, null, indent) + '\n';
}
