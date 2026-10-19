/**
 * schema ↔ types 一致性测试。
 *
 * 为什么需要这个文件：`types.ts` 与 `schema.ts` 是手写的两份声明（刻意不从 zod 反推类型，
 * 因为 schema 要比接口更宽容以容纳旧 IR 的默认值）。两份手写声明必然会漂移，而漂移的
 * 后果是「编译期看着对、运行时数据被静默丢弃」——Zod 默认 strip 未知键，多写的字段
 * 不会报错，会直接消失。
 *
 * 本文件用「构造每个类型的完整样本 → 过一遍 schema → 断言没有键被丢弃」来卡住这类漂移。
 * 注意：样本必须与 types.ts 逐字段对齐，写样本时以类型定义为准，不要凭印象。
 */

import { describe, expect, it } from 'vitest';

import {
  apiNodeSchema,
  canvasSchema,
  enumDefSchema,
  fieldBindingSchema,
  fieldSchema,
  fieldTypeSchema,
  irEdgeSchema,
  noteNodeSchema,
  pageComponentSchema,
  pageNodeSchema,
  projectSettingsSchema,
  tableNodeSchema,
} from '../src/schema.js';
import { buildFixture } from '../src/testing/fixtures.js';

/**
 * 检查对象过 schema 后是否有键被静默丢弃。
 */
function dropReport(input: unknown, parsed: unknown, path = '$'): string[] {
  if (Array.isArray(input)) {
    if (!Array.isArray(parsed)) return [`${path}: 数组被丢弃`];
    return input.flatMap((v, i) => dropReport(v, parsed[i], `${path}[${i}]`));
  }
  if (input !== null && typeof input === 'object') {
    if (parsed === null || typeof parsed !== 'object') return [`${path}: 对象被丢弃`];
    const inKeys = Object.keys(input as Record<string, unknown>);
    const outKeys = new Set(Object.keys(parsed as Record<string, unknown>));
    const missing = inKeys.filter((k) => !outKeys.has(k)).map((k) => `${path}.${k}`);
    const nested = inKeys
      .filter((k) => outKeys.has(k))
      .flatMap((k) =>
        dropReport((input as Record<string, unknown>)[k], (parsed as Record<string, unknown>)[k], `${path}.${k}`),
      );
    return [...missing, ...nested];
  }
  return [];
}

/** 一份「七段全字段」的设置样本，供多个用例复用 */
function sampleSettings() {
  return {
      frontend: {
        framework: 'vue' as const,
        ui: 'element-plus' as const,
        apiStyle: 'script-setup' as const,
        packageManager: 'pnpm' as const,
        stateSolution: 'pinia' as const,
        requestLib: 'axios' as const,
        strictness: 'strict' as const,
      },
      backend: {
        framework: 'nestjs' as const,
        orm: 'prisma' as const,
        validation: 'class-validator' as const,
        swagger: true,
        auth: 'none' as const,
      },
      naming: {
        tableCase: 'snake' as const,
        fieldCase: 'camel' as const,
        pathCase: 'kebab' as const,
        fileCase: 'kebab' as const,
      },
      generation: {
        outDir: 'output',
        sampleCount: 20,
        sampleSeed: 42,
        aiEnabled: false,
        aiProvider: 'openai-compatible' as const,
        aiModel: 'gpt-4.1',
      },
      import: {
        candidateAutoAcceptThreshold: 0.85,
        candidateManualThreshold: 0.5,
        visionProvider: 'openai-vision' as const,
      },
      export: { image: 'svg' as const, structure: 'json' as const, includeFieldPorts: false },
      lint: {
        enabled: true,
        blockOnError: true,
        ruleOverrides: { L010: 'warn' as const },
        ignores: [{ ruleId: 'L010', targetId: 'nd_AAAAAAAAAAAA', reason: '历史遗留' }],
      },
  };
}

describe('Field', () => {
  it('全字段样本不被 schema 丢键', () => {
    const sample = {
      id: 'fd_AAAAAAAAAAAA',
      name: 'deviceId',
      dbName: 'device_id',
      type: 'ref' as const,
      comment: '设备编号',
      description: '关联设备',
      required: true,
      nullable: false,
      readOnly: false,
      writeOnly: true,
      sensitive: true,
      deprecated: false,
      constraints: {
        minLength: 1,
        maxLength: 64,
        minimum: 0,
        maximum: 100,
        pattern: '^[A-Z]+$',
        enumRef: 'en_AAAAAAAAAAAA',
        enumValues: ['A', 'B'],
        default: 'A',
        precision: 10,
        scale: 2,
        arrayItem: 'string' as const,
        ref: { tableId: 'nd_AAAAAAAAAAAA', fieldId: 'fd_BBBBBBBBBBBB', onDelete: 'cascade' as const },
      },
      example: 'DEV-001',
      locked: true,
      port: { visible: true, order: 3 },
    };
    const parsed = fieldSchema.parse(sample);
    expect(dropReport(sample, parsed)).toEqual([]);
  });

  it('fieldTypeSchema 与 FieldType 联合完全一致（13 种）', () => {
    const expected = [
      'string',
      'text',
      'number',
      'integer',
      'boolean',
      'date',
      'datetime',
      'enum',
      'object',
      'array',
      'ref',
      'file',
      'json',
    ];
    expect([...fieldTypeSchema.options].sort()).toEqual([...expected].sort());
  });

  it('每种 FieldType 都能通过', () => {
    for (const type of fieldTypeSchema.options) {
      const r = fieldSchema.safeParse({ id: 'fd_BBBBBBBBBBBB', name: 'f', type, required: true, nullable: false });
      expect(r.success, `FieldType「${type}」应当被接受`).toBe(true);
    }
  });

  it('未知字段类型被拒绝（防止拼错静默通过）', () => {
    expect(fieldSchema.safeParse({ id: 'fd_CCCCCCCCCCCC', name: 'f', type: 'strng', required: false, nullable: true }).success).toBe(
      false,
    );
  });

  it('字段名必须是合法标识符', () => {
    expect(fieldSchema.safeParse({ id: 'fd_DDDDDDDDDDDD', name: 'device-id', type: 'string', required: false, nullable: true }).success).toBe(
      false,
    );
  });
});

describe('节点', () => {
  it('TableNode 全字段', () => {
    const { ir } = buildFixture();
    const node = ir.nodes.find((n) => n.kind === 'table');
    expect(node).toBeDefined();
    const parsed = tableNodeSchema.parse(node);
    expect(dropReport(node, parsed)).toEqual([]);
  });

  it('ApiNode 全字段', () => {
    const { ir } = buildFixture();
    const node = ir.nodes.find((n) => n.kind === 'api');
    expect(node).toBeDefined();
    const parsed = apiNodeSchema.parse(node);
    expect(dropReport(node, parsed)).toEqual([]);
  });

  it('PageNode 全字段（含全部组件类型）', () => {
    const { ir } = buildFixture();
    const node = ir.nodes.find((n) => n.kind === 'page');
    expect(node).toBeDefined();
    const parsed = pageNodeSchema.parse(node);
    expect(dropReport(node, parsed)).toEqual([]);
  });

  it('NoteNode 全字段（NoteDef 只有 text / groupId）', () => {
    const sample = {
      id: 'nd_AAAAAAAAAAAA',
      kind: 'note' as const,
      name: '备注',
      codeName: 'Note',
      canvasId: 'cv_AAAAAAAAAAAA',
      position: { x: 0, y: 0 },
      size: { w: 200, h: 100 },
      collapsed: false,
      tags: ['t'],
      color: '#ffffff',
      notes: '节点级备注',
      locked: true,
      note: { text: '正文', groupId: 'g1' },
    };
    const parsed = noteNodeSchema.parse(sample);
    expect(dropReport(sample, parsed)).toEqual([]);
  });
});

describe('组件', () => {
  it('FieldBinding 全字段', () => {
    const sample = {
      fieldRef: 'fd_AAAAAAAAAAAA',
      label: '显示名',
      control: 'select' as const,
      span: 12,
      placeholder: '请选择',
      rules: [{ type: 'required' as const, message: '必填', trigger: 'blur' as const }],
    };
    const parsed = fieldBindingSchema.parse(sample);
    expect(dropReport(sample, parsed)).toEqual([]);
  });

  it('fixture 里每个组件都不丢键', () => {
    const { ir } = buildFixture();
    for (const node of ir.nodes) {
      if (node.kind !== 'page') continue;
      for (const component of node.page.components) {
        const parsed = pageComponentSchema.parse(component);
        expect(dropReport(component, parsed)).toEqual([]);
      }
    }
  });

  it('拼错组件 type 会被拒绝', () => {
    expect(pageComponentSchema.safeParse({ id: 'cp_AAAAAAAAAAAA', type: 'unknowntype', bindings: [] }).success).toBe(false);
  });
});

describe('连线 / 设置 / 画布', () => {
  it('IREdge 全字段（含 transform / trigger / nav）', () => {
    const sample = {
      id: 'ed_AAAAAAAAAAAA',
      kind: 'map' as const,
      source: { nodeId: 'nd_AAAAAAAAAAAA', fieldId: 'fd_AAAAAAAAAAAA' },
      target: { nodeId: 'nd_BBBBBBBBBBBB', fieldId: 'fd_BBBBBBBBBBBB' },
      label: '映射',
      transform: { fn: 'custom' as const, args: ['a', 'b'], expression: '{a}-{b}' },
      trigger: { event: 'click' as const, componentId: 'cp_AAAAAAAAAAAA' },
      nav: { params: { id: 'x' }, query: { tab: 'a' } },
      canvasId: 'cv_AAAAAAAAAAAA',
    };
    const parsed = irEdgeSchema.parse(sample);
    expect(dropReport(sample, parsed)).toEqual([]);
  });

  it('call 连线的 mount 事件可以没有 componentId', () => {
    const sample = {
      id: 'ed_BBBBBBBBBBBB',
      kind: 'call' as const,
      source: { nodeId: 'nd_AAAAAAAAAAAA' },
      target: { nodeId: 'nd_BBBBBBBBBBBB' },
      trigger: { event: 'mount' as const },
      canvasId: 'cv_AAAAAAAAAAAA',
    };
    expect(irEdgeSchema.safeParse(sample).success).toBe(true);
  });

  it('ProjectSettings 七段全字段', () => {
    const sample = sampleSettings();
    const parsed = projectSettingsSchema.parse(sample);
    expect(dropReport(sample, parsed)).toEqual([]);
  });

  it('lint 忽略项必须填理由', () => {
    const base = projectSettingsSchema.parse(sampleSettings());
    const r = projectSettingsSchema.safeParse({
      ...base,
      lint: { ...base.lint, ignores: [{ ruleId: 'L1', targetId: 'x', reason: '' }] },
    });
    expect(r.success).toBe(false);
  });

  it('Canvas 全字段（含背景与网格）', () => {
    const sample = {
      id: 'cv_AAAAAAAAAAAA',
      name: '主画布',
      order: 0,
      viewport: { x: 10, y: 20, zoom: 1.5 },
      background: {
        assetId: 'as_AAAAAAAAAAAA',
        opacity: 0.25,
        locked: true,
        fit: 'contain' as const,
        offset: { x: 0, y: 0 },
        scale: 1,
      },
      grid: { enabled: true, size: 16 },
    };
    const parsed = canvasSchema.parse(sample);
    expect(dropReport(sample, parsed)).toEqual([]);
  });

  it('EnumDef 全字段', () => {
    const sample = {
      id: 'en_AAAAAAAAAAAA',
      name: 'DeviceStatus',
      description: '设备状态',
      values: [{ value: 'A', label: '甲', weight: 1, color: '#ff0000' }],
    };
    const parsed = enumDefSchema.parse(sample);
    expect(dropReport(sample, parsed)).toEqual([]);
  });

  it('枚举名必须是 PascalCase', () => {
    expect(
      enumDefSchema.safeParse({ id: 'en_BBBBBBBBBBBB', name: 'deviceStatus', values: [{ value: 'A' }] }).success,
    ).toBe(false);
  });
});
