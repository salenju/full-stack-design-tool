/**
 * IR 版本迁移。
 *
 * 目前只有 v1，迁移链为空——但**骨架必须现在就存在**，因为：
 * 一旦用户手里有 v1 的 IR 文件，将来改结构时若没有迁移通道，就只能让人工改 JSON。
 *
 * 约定：
 * - 每次不兼容变更 → `schemaVersion` +1，并新增一个 `v1ToV2` 迁移函数；
 * - 迁移函数必须是纯函数（不改入参）；
 * - 读文件发现低版本时，先备份 `<file>.v1.bak.json` 再迁移，绝不静默覆盖。
 */

import type { IR } from './types.js';

export type UnknownIR = Record<string, unknown> & { schemaVersion?: unknown };

export interface MigrationStep {
  from: number;
  to: number;
  /** 人类可读的迁移说明，会写进备份旁注与日志 */
  description: string;
  migrate: (input: UnknownIR) => UnknownIR;
}

/** 迁移链：按 from 升序注册 */
export const MIGRATIONS: MigrationStep[] = [];

export const CURRENT_SCHEMA_VERSION = 1;

export class UnsupportedSchemaVersionError extends Error {
  constructor(
    readonly found: unknown,
    readonly supported: number,
  ) {
    super(
      `不支持的 IR schemaVersion：${String(found)}（当前支持 ${supported}）。` +
        `请升级工具，或用较新版本打开后另存。`,
    );
    this.name = 'UnsupportedSchemaVersionError';
  }
}

/**
 * 把任意版本的 IR 升级到当前版本。
 * 返回值是**新对象**，入参不被修改。
 */
export function migrateToCurrent(input: UnknownIR): { ir: UnknownIR; applied: MigrationStep[] } {
  const applied: MigrationStep[] = [];
  let current = input;

  // 缺 schemaVersion 的历史数据按 v1 处理（v1 是最早的公开格式）
  const rawVersion = current.schemaVersion;
  // 非法版本号必须在这里拦下，不能放行到 while 循环：
  // - NaN 会「既不大于也不小于」，绕过上面的版本比较直接跳过全部迁移；
  // - 1.5 / "2" 无法匹配任何迁移步，报出来的会是「迁移链不完整」而非「版本不认识」，
  //   把用户引向错误方向（以为是工具 bug 而不是文件太新/被改坏）。
  if (
    rawVersion !== undefined &&
    (typeof rawVersion !== 'number' || !Number.isInteger(rawVersion) || rawVersion < 1)
  ) {
    throw new UnsupportedSchemaVersionError(rawVersion, CURRENT_SCHEMA_VERSION);
  }
  let version = typeof rawVersion === 'number' ? rawVersion : 1;

  if (version > CURRENT_SCHEMA_VERSION) {
    throw new UnsupportedSchemaVersionError(version, CURRENT_SCHEMA_VERSION);
  }

  while (version < CURRENT_SCHEMA_VERSION) {
    const step = MIGRATIONS.find((m) => m.from === version);
    if (step === undefined) {
      throw new Error(`缺少从 v${version} 到 v${version + 1} 的迁移函数，迁移链不完整`);
    }
    current = step.migrate(current);
    current = { ...current, schemaVersion: step.to };
    applied.push(step);
    version = step.to;
  }

  if (typeof current.schemaVersion !== 'number') {
    current = { ...current, schemaVersion: CURRENT_SCHEMA_VERSION };
  }

  return { ir: current, applied };
}

/** 便捷封装：迁移 + 类型断言（调用方仍需跑 schema 校验） */
export function migrateIR(input: UnknownIR): IR {
  return migrateToCurrent(input).ir as unknown as IR;
}
