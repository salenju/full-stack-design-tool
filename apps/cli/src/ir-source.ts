/**
 * IR 来源解析（TD 16.5 双模式边界）。
 *
 * 规则只有一条：**同一项目同一时刻只有一个权威存储**。所以：
 * - 给了 `--ir <path>` → 文件模式，直接读写该文件，不碰 `~/.fsdt/`；
 * - 没给 → 找当前目录（含向上若干层）的 `design/ir.json`；
 * - 都没有 → 用法错误，并明确告诉用户该跑 `fsdt init`。
 *
 * 刻意**不做**「没找到就悄悄建一个空 IR」：那会让 `fsdt lint` 在错误的目录里
 * 报「0 个问题」并通过 CI，而实际上它根本没检查任何东西。
 */

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { IR } from '@fsdt/core-ir';
import { loadIR } from '@fsdt/core-ir';
import { UsageError } from './io.js';

export const DESIGN_DIR = 'design';
export const IR_FILE = 'ir.json';
export const MANIFEST_FILE = 'generated.manifest.json';

export interface IrSource {
  /** IR 文件绝对路径 */
  path: string;
  /** design/ 目录绝对路径 */
  designDir: string;
  /** 项目根（design/ 的父目录） */
  projectRoot: string;
  mode: 'file';
}

/** 从 cwd 向上找 design/ir.json，找到就返回 */
export function findIr(startDir: string, explicitPath?: string): IrSource {
  if (explicitPath !== undefined) {
    const path = resolve(startDir, explicitPath);
    if (!existsSync(path)) throw new UsageError(`IR 文件不存在：${path}`);
    const designDir = path.endsWith(join(DESIGN_DIR, IR_FILE)) ? join(path, '..') : join(path, '..');
    return { path, designDir, projectRoot: join(designDir, '..'), mode: 'file' };
  }

  let dir = resolve(startDir);
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, DESIGN_DIR, IR_FILE);
    if (existsSync(candidate)) {
      return { path: candidate, designDir: join(dir, DESIGN_DIR), projectRoot: dir, mode: 'file' };
    }
    const parent = join(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  throw new UsageError(
    `未找到 ${DESIGN_DIR}/${IR_FILE}（从 ${startDir} 向上查找 8 层）。` +
      '请在项目根执行 `fsdt init`，或用 `--ir <path>` 显式指定 IR 文件。',
  );
}

export interface LoadedIr {
  ir: IR;
  /** 应用过的迁移版本号（非空时会提示用户先提交备份文件） */
  migrated: number[];
  backupPath?: string;
}

export async function loadIrFrom(source: IrSource): Promise<LoadedIr> {
  const result = await loadIR(source.path);
  return {
    ir: result.ir,
    migrated: result.migrated,
    ...(result.backupPath !== undefined ? { backupPath: result.backupPath } : {}),
  };
}

export function manifestPathOf(source: IrSource): string {
  return join(source.designDir, MANIFEST_FILE);
}
