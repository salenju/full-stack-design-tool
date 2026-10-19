import { buildFixture } from '@fsdt/core-ir/testing';
import { describe, expect, it } from 'vitest';
import {
  ApplyError,
  applyDecisions,
  candidateIdOf,
  combineConfidence,
  createFigmaExtractor,
  createVisionExtractor,
  denormalizeBbox,
  extractFromNodes,
  groupRoleOf,
  hasCJK,
  inferFromLayerName,
  inferFromText,
  normalizeVisionOutput,
  sourceMarkOf,
  toFieldName,
  toRoute,
  type Decision,
  type FigmaNodesResponse,
  type ExtractionResult,
} from '../src/index.js';

// ────────────────────────────── Figma 节点树样例 ──────────────────────────────

function figmaTree(): FigmaNodesResponse {
  return {
    name: '设备管理',
    version: '123456',
    nodes: {
      '1:1': {
        document: {
          id: '1:1',
          name: 'DeviceList',
          type: 'FRAME',
          absoluteBoundingBox: { x: 0, y: 0, width: 1440, height: 900 },
          children: [
            {
              id: '1:2',
              name: '搜索区',
              type: 'FRAME',
              absoluteBoundingBox: { x: 0, y: 0, width: 1440, height: 80 },
              children: [
                {
                  id: '1:3',
                  name: 'FormItem/deviceName',
                  type: 'INSTANCE',
                  componentName: 'Input',
                  absoluteBoundingBox: { x: 16, y: 16, width: 220, height: 32 },
                  children: [
                    {
                      id: '1:4',
                      name: '请输入设备名称',
                      type: 'TEXT',
                      characters: '请输入设备名称',
                      absoluteBoundingBox: { x: 28, y: 24, width: 160, height: 16 },
                    },
                  ],
                },
                {
                  id: '1:5',
                  name: 'FormItem/status',
                  type: 'INSTANCE',
                  componentName: 'Select',
                  absoluteBoundingBox: { x: 260, y: 16, width: 160, height: 32 },
                  children: [
                    {
                      id: '1:6',
                      name: '请选择状态',
                      type: 'TEXT',
                      characters: '请选择状态',
                      absoluteBoundingBox: { x: 272, y: 24, width: 100, height: 16 },
                    },
                  ],
                },
              ],
            },
            {
              id: '1:7',
              name: '表格',
              type: 'FRAME',
              absoluteBoundingBox: { x: 0, y: 100, width: 1440, height: 600 },
              children: [
                {
                  id: '1:8',
                  name: 'TableColumn/deviceId',
                  type: 'FRAME',
                  absoluteBoundingBox: { x: 16, y: 120, width: 160, height: 40 },
                },
                {
                  id: '1:9',
                  name: 'Row',
                  type: 'FRAME',
                  absoluteBoundingBox: { x: 16, y: 160, width: 1400, height: 40 },
                  children: [
                    {
                      id: '1:10',
                      name: 'Cell',
                      type: 'TEXT',
                      characters: 'DEV-0001',
                      absoluteBoundingBox: { x: 16, y: 168, width: 120, height: 16 },
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    },
  };
}

describe('Figma 节点树提取', () => {
  it('识别搜索区字段并带上 group 与证据', () => {
    const result = extractFromNodes(figmaTree());
    const deviceName = result.candidates.find((c) => c.name === 'deviceName');
    expect(deviceName).toBeDefined();
    expect(deviceName?.group?.role).toBe('search');
    expect(deviceName?.evidence.some((e) => e.kind === 'layerName')).toBe(true);
  });

  it('从 placeholder 文本判定控件类型（请选择→select）', () => {
    const result = extractFromNodes(figmaTree());
    const status = result.candidates.find((c) => c.name === 'status');
    expect(status?.control).toBe('select');
    expect(status?.type).toBe('enum');
  });

  it('表格单元格的文本不被当成字段标签（那是数据不是标签）', () => {
    const result = extractFromNodes(figmaTree());
    expect(result.candidates.some((c) => c.name === 'DEV-0001')).toBe(false);
  });

  it('表格列图层识别为列（control=slot）', () => {
    const result = extractFromNodes(figmaTree());
    const col = result.candidates.find((c) => c.name === 'deviceId');
    expect(col?.control).toBe('slot');
  });

  it('顶层 FRAME 变成页面并给出路由建议', () => {
    const result = extractFromNodes(figmaTree());
    expect(result.pages.length).toBeGreaterThan(0);
    expect(result.pages[0]?.suggestedRoute.startsWith('/')).toBe(true);
  });

  it('候选按置信度降序排列', () => {
    const result = extractFromNodes(figmaTree());
    const scores = result.candidates.map((c) => c.confidence);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it('同一输入两次提取结果完全一致（可复现是这条路线的全部价值）', () => {
    const a = extractFromNodes(figmaTree());
    const b = extractFromNodes(figmaTree());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('空节点树给出明确告警而不是静默返回空数组', () => {
    const result = extractFromNodes({ nodes: {} });
    expect(result.candidates).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('按 componentName 推断控件：Input→input，Select→select', () => {
    expect(inferFromLayerName('Input')?.control).toBe('input');
    // 图层名里的 'status' 不说明控件类型，只有组件名 / 同级 Select 段能说明
    expect(inferFromLayerName('FormItem/status')).toBeUndefined();
    expect(inferFromLayerName('Select')?.control).toBe('select');
    expect(inferFromLayerName('FormItem/DatePicker')?.control).toBe('date');
    expect(inferFromLayerName('DateTimePicker')?.type).toBe('datetime');
    expect(inferFromLayerName('DatePicker')?.type).toBe('date');
    expect(inferFromLayerName('随便什么')).toBeUndefined();
  });

  it('字段名来自图层名而不是组件名（否则所有下拉框都叫 select）', () => {
    const result = extractFromNodes(figmaTree());
    // 图层名是 FormItem/status，组件名是 Select
    const status = result.candidates.find((c) => c.name === 'status');
    expect(status).toBeDefined();
    expect(result.candidates.some((c) => c.name === 'Select')).toBe(false);
  });

  it('一条强证据就够：置信度取最大值而非均值', () => {
    // 0.9（文本）+ 弱证据不该被拉低
    expect(combineConfidence([0.9, 0.6])).toBeGreaterThanOrEqual(0.9);
    expect(combineConfidence([])).toBe(0);
    expect(combineConfidence([0.9, 0.8, 0.7, 0.6, 0.5])).toBeLessThanOrEqual(0.99);
  });
});

describe('Figma 网络通道', () => {
  it('缺 token 或 fileKey 时报错并说明从环境变量读', async () => {
    const extractor = createFigmaExtractor();
    await expect(extractor.extract({ channel: 'figma', fileKey: 'k' })).rejects.toThrow(/token/);
    await expect(extractor.extract({ channel: 'figma', token: 't' })).rejects.toThrow(/fileKey/);
  });

  it('通过注入的 fetchJson 拉取，不真正联网', async () => {
    let calledUrl = '';
    const extractor = createFigmaExtractor();
    const result = await extractor.extract(
      { channel: 'figma', fileKey: 'FILEKEY', nodeIds: ['1:1'], token: 'T' },
      {
        fetchJson: async (url) => {
          calledUrl = url;
          return figmaTree();
        },
      },
    );
    expect(calledUrl).toContain('/files/FILEKEY/nodes');
    expect(calledUrl).toContain('ids=1%3A1');
    expect(result.candidates.length).toBeGreaterThan(0);
  });
});

describe('视觉模型输出校验', () => {
  const options = { imageWidth: 1000, imageHeight: 500 };

  it('合法输出被原样接受', () => {
    const outcome = normalizeVisionOutput(
      {
        candidates: [
          { name: 'deviceName', label: '设备名称', type: 'string', control: 'input', confidence: 0.9 },
        ],
      },
      options,
    );
    expect(outcome.candidates).toHaveLength(1);
    expect(outcome.dropped).toBe(0);
  });

  it('类型不在闭集内的候选被丢弃而不是被「修正」', () => {
    const outcome = normalizeVisionOutput(
      { candidates: [{ name: 'x', type: 'datetime2', control: 'input' }] },
      options,
    );
    expect(outcome.candidates).toHaveLength(0);
    expect(outcome.dropped).toBe(1);
  });

  it('bbox 越界视为幻觉，坐标被丢弃但候选保留', () => {
    const outcome = normalizeVisionOutput(
      { candidates: [{ name: 'x', type: 'string', control: 'input', bbox: { x: 2, y: 0, w: 0.1, h: 0.1 } }] },
      options,
    );
    expect(outcome.candidates).toHaveLength(1);
    expect(outcome.candidates[0]?.evidence.some((e) => e.kind === 'bbox')).toBe(false);
  });

  it('归一化 bbox 正确换算为像素', () => {
    const box = denormalizeBbox({ x: 0.5, y: 0.5, w: 0.25, h: 0.1 }, 1000, 500);
    expect(box).toEqual({ x: 500, y: 250, w: 250, h: 50 });
  });

  it('置信度被钳到 0–1，并按降序排序', () => {
    const outcome = normalizeVisionOutput(
      {
        candidates: [
          { name: 'a', type: 'string', control: 'input', confidence: 5 },
          { name: 'b', type: 'string', control: 'input', confidence: -3 },
        ],
      },
      options,
    );
    expect(outcome.candidates[0]?.confidence).toBe(1);
    expect(outcome.candidates[1]?.confidence).toBe(0);
  });

  it('整体非对象时给出明确告警', () => {
    const outcome = normalizeVisionOutput('not json', options);
    expect(outcome.warnings.length).toBeGreaterThan(0);
  });

  it('缺 candidates 数组时告警而不是抛错', () => {
    const outcome = normalizeVisionOutput({ pages: [] }, options);
    expect(outcome.candidates).toHaveLength(0);
    expect(outcome.warnings.join()).toMatch(/candidates/);
  });

  it('模型完全失败时重试一次，第二次成功即用', async () => {
    let calls = 0;
    const extractor = createVisionExtractor({
      callModel: async () => {
        calls++;
        if (calls === 1) return { candidates: [] };
        return { candidates: [{ name: 'deviceName', type: 'string', control: 'input', confidence: 0.8 }] };
      },
      imageWidth: 100,
      imageHeight: 100,
    });
    const result = await extractor.extract({ channel: 'vision', imagePath: 'x.png' });
    expect(calls).toBe(2);
    expect(result.candidates).toHaveLength(1);
  });

  it('没有图片路径时立即报错', async () => {
    const extractor = createVisionExtractor({ callModel: async () => ({}), imageWidth: 1, imageHeight: 1 });
    await expect(extractor.extract({ channel: 'vision' })).rejects.toThrow(/imagePath/);
  });
});

describe('名称规范化', () => {
  it('英文图层名转 camelCase', () => {
    expect(toFieldName('FormItem/device_name')).toBe('deviceName');
    expect(toFieldName('TableColumn/created at')).toBe('createdAt');
  });

  it('纯中文不生成拼音字段名（那是反模式）', () => {
    expect(toFieldName('设备名称')).toBeUndefined();
    expect(hasCJK('设备名称')).toBe(true);
  });

  it('中文名不能直接当路由段', () => {
    expect(toRoute(['设备管理'])).toBe('/');
    expect(toRoute(['Device', 'List'])).toBe('/device/list');
  });

  it('文本推断：金额→number、状态→enum、备注→textarea', () => {
    expect(inferFromText('金额')?.type).toBe('number');
    expect(inferFromText('状态')?.control).toBe('select');
    expect(inferFromText('备注')?.control).toBe('textarea');
    expect(inferFromText('创建时间')?.type).toBe('datetime');
  });

  it('区域角色识别覆盖中英文', () => {
    expect(groupRoleOf('搜索区')).toBe('search');
    expect(groupRoleOf('Table')).toBe('table');
    expect(groupRoleOf('随便什么')).toBeUndefined();
  });

  it('候选 ID 稳定：同 key 同结果', () => {
    expect(candidateIdOf('figma', '1:3')).toBe(candidateIdOf('figma', '1:3'));
    expect(candidateIdOf('figma', '1:3')).not.toBe(candidateIdOf('figma', '1:4'));
    expect(candidateIdOf('figma', '1:3')).toMatch(/^cd_fi[0-9a-f]{8}$/);
  });
});

// ────────────────────────────── apply ──────────────────────────────

function extractionOf(candidates: Array<{ id: string; name: string; type?: 'string' | 'enum'; label?: string }>): ExtractionResult {
  return {
    candidates: candidates.map((c) => ({
      id: c.id,
      name: c.name,
      ...(c.label !== undefined ? { label: c.label } : {}),
      type: c.type ?? 'string',
      control: 'input',
      confidence: 0.9,
      evidence: [{ kind: 'text', value: c.name }],
      decision: 'pending',
    })),
    groups: [],
    pages: [],
    warnings: [],
  };
}

describe('候选应用（applyDecisions）', () => {
  it('往已有表节点加字段，返回新 IR 不改入参', () => {
    const { ir, deviceTable } = buildFixture();
    const before = JSON.stringify(ir);
    const extraction = extractionOf([{ id: 'cd_a1', name: 'remark', label: '备注' }]);
    const result = applyDecisions(
      ir,
      extraction,
      [{ candidateId: 'cd_a1', action: 'accept' }],
      { mode: 'existing', nodeId: deviceTable.id },
    );
    expect(result.added).toBe(1);
    expect(JSON.stringify(ir)).toBe(before);
    const node = result.ir.nodes.find((n) => n.id === deviceTable.id);
    expect(node?.kind === 'table' && node.table.fields.some((f) => f.name === 'remark')).toBe(true);
  });

  it('幂等：同一候选重复 apply 不产生重复字段', () => {
    const { ir, deviceTable } = buildFixture();
    const extraction = extractionOf([{ id: 'cd_a2', name: 'remark' }]);
    const decisions: Decision[] = [{ candidateId: 'cd_a2', action: 'accept' }];
    const first = applyDecisions(ir, extraction, decisions, { mode: 'existing', nodeId: deviceTable.id });
    const second = applyDecisions(first.ir, extraction, decisions, { mode: 'existing', nodeId: deviceTable.id });
    expect(second.added).toBe(0);
    expect(second.skipped).toBe(1);
    const node = second.ir.nodes.find((n) => n.id === deviceTable.id);
    expect(node?.kind === 'table' && node.table.fields.filter((f) => f.name === 'remark')).toHaveLength(1);
  });

  it('comment 里带来源标记，幂等靠它判重', () => {
    const { ir, deviceTable } = buildFixture();
    const extraction = extractionOf([{ id: 'cd_a3', name: 'remark', label: '备注' }]);
    const result = applyDecisions(ir, extraction, [{ candidateId: 'cd_a3', action: 'accept' }], {
      mode: 'existing',
      nodeId: deviceTable.id,
    });
    const node = result.ir.nodes.find((n) => n.id === deviceTable.id);
    const field = node?.kind === 'table' ? node.table.fields.find((f) => f.name === 'remark') : undefined;
    expect(field?.comment).toContain(sourceMarkOf('cd_a3'));
    expect(field?.comment).toContain('备注');
  });

  it('新建表节点：dbName 冲突时自动改名并告警', () => {
    const { ir, deviceTable } = buildFixture();
    const extraction = extractionOf([{ id: 'cd_a4', name: 'foo' }]);
    const result = applyDecisions(ir, extraction, [{ candidateId: 'cd_a4', action: 'accept' }], {
      mode: 'new',
      name: '导入的表',
      dbName: deviceTable.table.dbName,
    });
    expect(result.warnings.join()).toMatch(/已改为/);
    expect(result.added).toBe(1);
  });

  it('拒绝未知候选与重复决策', () => {
    const { ir, deviceTable } = buildFixture();
    const extraction = extractionOf([{ id: 'cd_a5', name: 'x' }]);
    expect(() =>
      applyDecisions(ir, extraction, [{ candidateId: 'nope', action: 'accept' }], { mode: 'existing', nodeId: deviceTable.id }),
    ).toThrow(ApplyError);
    expect(() =>
      applyDecisions(
        ir,
        extraction,
        [
          { candidateId: 'cd_a5', action: 'accept' },
          { candidateId: 'cd_a5', action: 'skip' },
        ],
        { mode: 'existing', nodeId: deviceTable.id },
      ),
    ).toThrow(/多次决策/);
  });

  it('pending 未处理时给出告警（不静默当成已处理）', () => {
    const { ir, deviceTable } = buildFixture();
    const extraction = extractionOf([
      { id: 'cd_a6', name: 'x' },
      { id: 'cd_a7', name: 'y' },
    ]);
    const result = applyDecisions(ir, extraction, [{ candidateId: 'cd_a6', action: 'accept' }], {
      mode: 'existing',
      nodeId: deviceTable.id,
    });
    expect(result.warnings.join()).toMatch(/未做决定/);
  });

  it('目标不是表节点时拒绝应用', () => {
    const { ir, listPage } = buildFixture();
    const extraction = extractionOf([{ id: 'cd_a8', name: 'x' }]);
    expect(() =>
      applyDecisions(ir, extraction, [{ candidateId: 'cd_a8', action: 'accept' }], { mode: 'existing', nodeId: listPage.id }),
    ).toThrow(/不是表节点/);
  });

  it('overrides 改名与改类型生效', () => {
    const { ir, deviceTable } = buildFixture();
    const extraction = extractionOf([{ id: 'cd_a9', name: 'x' }]);
    const result = applyDecisions(
      ir,
      extraction,
      [{ candidateId: 'cd_a9', action: 'accept', overrides: { name: 'customName', type: 'enum' } }],
      { mode: 'existing', nodeId: deviceTable.id },
    );
    const node = result.ir.nodes.find((n) => n.id === deviceTable.id);
    const field = node?.kind === 'table' ? node.table.fields.find((f) => f.name === 'customName') : undefined;
    expect(field?.type).toBe('enum');
  });
});
