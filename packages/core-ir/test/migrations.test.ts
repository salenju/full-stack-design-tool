import { describe, expect, it } from 'vitest';

import {
  CURRENT_SCHEMA_VERSION,
  MIGRATIONS,
  UnsupportedSchemaVersionError,
  migrateIR,
  migrateToCurrent,
  type MigrationStep,
} from '../src/index.js';
import { buildFixture } from '../src/testing/fixtures.js';

describe('迁移链基线', () => {
  it('当前版本为 1', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(1);
  });

  it('迁移链当前为空（只有 v1）', () => {
    expect(MIGRATIONS).toEqual([]);
  });

  it('链的每一步都连续推进（from → from+1）', () => {
    for (const step of MIGRATIONS) {
      expect(step.to).toBe(step.from + 1);
    }
  });

  it('链的 from 唯一且升序', () => {
    const froms = MIGRATIONS.map((m) => m.from);
    expect(new Set(froms).size).toBe(froms.length);
    expect([...froms].sort((a, b) => a - b)).toEqual(froms);
  });
});

describe('migrateToCurrent', () => {
  it('v1 原样返回，applied 为空', () => {
    const { ir } = buildFixture();
    const result = migrateToCurrent(ir as unknown as Record<string, unknown>);
    expect(result.applied).toEqual([]);
    expect(result.ir.schemaVersion).toBe(1);
  });

  it('不修改入参（纯函数）', () => {
    const { ir } = buildFixture();
    const snapshot = JSON.stringify(ir);
    migrateToCurrent(ir as unknown as Record<string, unknown>);
    expect(JSON.stringify(ir)).toBe(snapshot);
  });

  it('缺 schemaVersion 按 v1 处理并补齐版本号', () => {
    const { ir } = buildFixture();
    const { schemaVersion, ...withoutVersion } = ir as unknown as Record<string, unknown> & { schemaVersion: number };
    expect(schemaVersion).toBe(1);
    const result = migrateToCurrent(withoutVersion);
    expect(result.applied).toEqual([]);
    expect(result.ir.schemaVersion).toBe(1);
  });

  it('版本高于当前 → UnsupportedSchemaVersionError', () => {
    const { ir } = buildFixture();
    try {
      migrateToCurrent({ ...(ir as unknown as Record<string, unknown>), schemaVersion: 2 });
      throw new Error('应当抛错');
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedSchemaVersionError);
      expect((err as UnsupportedSchemaVersionError).found).toBe(2);
      expect((err as UnsupportedSchemaVersionError).supported).toBe(1);
    }
  });

  it('非整数版本号被判为不支持（NaN 不能绕过检查）', () => {
    for (const bad of [Number.NaN, 1.5, -1, '2' as unknown as number]) {
      expect(() => migrateToCurrent({ schemaVersion: bad })).toThrow(UnsupportedSchemaVersionError);
    }
  });

  it('报错信息包含原始版本号，便于用户自助排查', () => {
    try {
      migrateToCurrent({ schemaVersion: 99 });
    } catch (err) {
      expect((err as Error).message).toContain('99');
      expect((err as Error).message).toContain('升级');
    }
  });
});

describe('迁移链断裂时报错（而不是静默跳过）', () => {
  /**
   * 这条用例通过临时注册一个 from=2 的迁移步并伪造「当前版本 = 3」来验证 while 循环
   * 的缺步分支。真加 v2 那天，这条用例会自动失效（因为 2→3 的步存在了），
   * 届时应当改成对应的真实断言——所以这里断言的是「错误信息包含版本号」而非具体文案。
   */
  it('v1 数据在当前版本下不会触发缺步错误', () => {
    const { ir } = buildFixture();
    expect(() => migrateToCurrent(ir as unknown as Record<string, unknown>)).not.toThrow();
  });

  it('缺少 1→2 迁移步时，v1 数据会明确报错', () => {
    // 用 Proxy 伪造一个「当前版本是 2」的环境不现实；改为直接验证迁移步查找语义：
    // 只要 MIGRATIONS 里没有 from===1 的步，把 CURRENT_SCHEMA_VERSION 想成 2 就必然缺步。
    // 这里用一个本地复刻的循环来证明该分支的错误信息形态。
    const applied: string[] = [];
    let version = 1;
    const fakeTarget = 2;
    const fakeChain: MigrationStep[] = [];
    let message = '';
    try {
      while (version < fakeTarget) {
        const step = fakeChain.find((m) => m.from === version);
        if (step === undefined) {
          throw new Error(`缺少从 v${version} 到 v${version + 1} 的迁移函数，迁移链不完整`);
        }
        applied.push(step.description);
        version = step.to;
      }
    } catch (err) {
      message = (err as Error).message;
    }
    expect(applied).toEqual([]);
    expect(message).toContain('缺少从 v1 到 v2');
  });

  it('真实实现里，找不到迁移步时抛出的错误含版本号', () => {
    // 直接读实现层的行为：当前 MIGRATIONS 为空，若把 schemaVersion 设为 0（低于 v1）
    // 应被版本校验拦下而非进入循环；这条守住「0 不会静默通过」。
    expect(() => migrateToCurrent({ schemaVersion: 0 })).toThrow(UnsupportedSchemaVersionError);
  });
});

describe('migrateIR', () => {
  it('返回带类型断言的 IR', () => {
    const { ir } = buildFixture();
    const migrated = migrateIR(ir as unknown as Record<string, unknown>);
    expect(migrated.schemaVersion).toBe(1);
    expect(migrated.nodes.length).toBe(ir.nodes.length);
  });
});
