import {
  createField,
  createForm,
  newEdgeId,
  type IR,
} from '@fsdt/core-ir';
import { buildFixture } from '@fsdt/core-ir/testing';
import { describe, expect, it } from 'vitest';

import { applyFixes, summarizeFixes } from '../src/fixes.js';
import { runLint } from '../src/rules.js';

/** 只取带 fix 载荷的 issue，模拟 `--fix` 会处理的那部分 */
function fixable(ir: IR) {
  return runLint(ir).issues.filter((i) => i.fix !== undefined);
}

describe('applyFixes', () => {
  it('修 L010 的字段命名，并把字段名改成 camelCase', () => {
    const fixture = buildFixture();
    fixture.deviceNameField.name = 'Device_Name';

    const issues = fixable(fixture.ir).filter((i) => i.ruleId === 'L010' && i.fix?.kind === 'renameField');
    expect(issues.length).toBeGreaterThan(0);

    const { ir, applied } = applyFixes(fixture.ir, issues);
    const field = ir.nodes
      .filter((n) => n.kind === 'table')
      .flatMap((n) => (n.kind === 'table' ? n.table.fields : []))
      .find((f) => f.id === fixture.deviceNameField.id);

    expect(applied.length).toBeGreaterThan(0);
    expect(field?.name).toBe('deviceName');
  });

  it('修 L010 的表名，改的是 dbName 而不是展示名', () => {
    const fixture = buildFixture();
    fixture.deviceTable.table.dbName = 'DeviceList';

    const issues = fixable(fixture.ir).filter((i) => i.fix?.kind === 'renameNode');
    const { ir } = applyFixes(fixture.ir, issues);
    const table = ir.nodes.find((n) => n.id === fixture.deviceTable.id);

    expect(table?.kind).toBe('table');
    if (table?.kind === 'table') {
      expect(table.table.dbName).toBe('device_list');
      // 展示名不该被顺手改掉
      expect(table.name).toBe('设备');
    }
  });

  it('修 L007 的分页参数，补齐 page 与 pageSize', () => {
    const fixture = buildFixture();
    fixture.listApi.api.query = [];

    const issues = fixable(fixture.ir).filter((i) => i.fix?.kind === 'addPaginationParams');
    expect(issues.length).toBe(1);

    const { ir } = applyFixes(fixture.ir, issues);
    const api = ir.nodes.find((n) => n.id === fixture.listApi.id);
    expect(api?.kind).toBe('api');
    if (api?.kind === 'api') {
      const names = api.api.query.map((f) => f.name);
      expect(names).toContain('page');
      expect(names).toContain('pageSize');
    }
  });

  it('修 L005 的表单绑定，把缺失的必填字段补进 bindings', () => {
    const fixture = buildFixture();
    const form = createForm(fixture.createApi.id, [], { title: '新建' });
    fixture.listPage.page.components.push(form);

    const issues = fixable(fixture.ir).filter((i) => i.fix?.kind === 'bindField');
    expect(issues.length).toBeGreaterThan(0);

    const { ir } = applyFixes(fixture.ir, issues);
    const page = ir.nodes.find((n) => n.id === fixture.listPage.id);
    const patched = page?.kind === 'page' ? page.page.components.find((c) => c.id === form.id) : undefined;

    expect(patched?.bindings.length).toBeGreaterThan(0);
  });

  it('修 L002 的悬空边，把边删掉', () => {
    const fixture = buildFixture();
    fixture.ir.edges.push({
      id: newEdgeId(),
      kind: 'call',
      source: { nodeId: fixture.listPage.id },
      target: { nodeId: 'nd_doesnotexist01' },
      canvasId: fixture.canvas.id,
    });

    const issues = fixable(fixture.ir).filter((i) => i.fix?.kind === 'removeEdge');
    expect(issues.length).toBe(1);

    const { ir } = applyFixes(fixture.ir, issues);
    expect(ir.edges.some((e) => e.target.nodeId === 'nd_doesnotexist01')).toBe(false);
  });

  it('枚举取值无法推断时跳过，并给出原因而不是塞假值', () => {
    const fixture = buildFixture();
    fixture.statusField.constraints = {};

    const issues = fixable(fixture.ir).filter((i) => i.fix?.kind === 'addEnumValues');
    expect(issues.length).toBeGreaterThan(0);

    const { applied, skipped, ir } = applyFixes(fixture.ir, issues);
    expect(applied.length).toBe(0);
    expect(skipped.length).toBeGreaterThan(0);
    expect(skipped[0]?.reason).toContain('无法推断');
    expect(ir).toEqual(fixture.ir);
  });

  it('不改入参：原始 IR 保持不变', () => {
    const fixture = buildFixture();
    fixture.deviceNameField.name = 'Bad_Name';
    const snapshot = structuredClone(fixture.ir);

    applyFixes(fixture.ir, fixable(fixture.ir));
    expect(fixture.ir).toEqual(snapshot);
  });

  it('修复后重跑 Lint，带 fix 的问题数量下降', () => {
    const fixture = buildFixture();
    fixture.listApi.api.query = [];
    fixture.deviceNameField.name = 'Bad_Name';

    const before = fixable(fixture.ir).length;
    expect(before).toBeGreaterThan(0);

    const { ir } = applyFixes(fixture.ir, fixable(fixture.ir));
    const after = fixable(ir).length;
    expect(after).toBeLessThan(before);
  });

  it('载荷与前提不符时跳过，不硬改', () => {
    const fixture = buildFixture();
    const issues = [
      {
        ruleId: 'L010',
        severity: 'warn' as const,
        message: '手工构造的过期 issue',
        target: { fieldId: fixture.deviceNameField.id },
        fix: {
          kind: 'renameField' as const,
          fieldId: fixture.deviceNameField.id,
          from: 'oldNameThatNoLongerExists',
          to: 'whatever',
        },
      },
    ];

    const { applied, skipped } = applyFixes(fixture.ir, issues);
    expect(applied.length).toBe(0);
    expect(skipped[0]?.reason).toContain('与修复前提');
  });

  it('摘要能同时表达修复数与跳过数', () => {
    const fixture = buildFixture();
    fixture.listApi.api.query = [];
    const result = applyFixes(fixture.ir, fixable(fixture.ir));
    expect(summarizeFixes(result)).toMatch(/已修复|跳过/);
  });

  it('没有 fix 载荷的 issue 一律不动', () => {
    const fixture = buildFixture();
    fixture.deviceTable.table.fields.push(createField({ name: 'note', type: 'string' }));
    const issues = runLint(fixture.ir).issues.filter((i) => i.fix === undefined);

    const { applied } = applyFixes(fixture.ir, issues);
    expect(applied.length).toBe(0);
  });
});
