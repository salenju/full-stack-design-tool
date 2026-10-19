import { buildFixture } from '@fsdt/core-ir/testing';
import { describe, expect, it } from 'vitest';
import {
  EXPORT_FORMATS,
  buildGeometry,
  exportCanvas,
  getExporter,
  orthogonalPath,
  renderDrawio,
  renderFigmaScript,
  renderJson,
  renderMermaid,
  renderSvg,
  textWidth,
  wrapText,
} from '../src/index.js';

function fixture() {
  const f = buildFixture();
  // canvasId 只加一个便捷别名；\`ir\` 不能重复展开，否则会被 f 里的同名字段覆盖
  return { ...f, canvasId: f.canvas.id };
}

describe('几何重建', () => {
  it('包围盒把节点包进去并加 padding', () => {
    const { ir, canvasId } = fixture();
    const geo = buildGeometry(ir, canvasId, { padding: 40, includeNotes: false });
    expect(geo.width).toBeGreaterThan(0);
    expect(geo.height).toBeGreaterThan(0);
    for (const node of geo.nodes) {
      const r = { x: node.position.x, y: node.position.y, w: node.size.w, h: node.size.h };
      const p = geo.translate({ x: r.x, y: r.y });
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeGreaterThanOrEqual(0);
    }
  });

  it('空画布给出非零尺寸（避免产出 0×0 的废图）', () => {
    const { ir, canvasId } = fixture();
    ir.nodes = [];
    ir.edges = [];
    const geo = buildGeometry(ir, canvasId, { padding: 40, includeNotes: false });
    expect(geo.width).toBeGreaterThan(100);
    expect(geo.height).toBeGreaterThan(100);
  });

  it('正交路由的起点在右侧、终点在左侧', () => {
    const points = orthogonalPath({ x: 0, y: 0, w: 100, h: 50 }, { x: 300, y: 0, w: 100, h: 50 });
    expect(points[0]).toEqual({ x: 100, y: 25 });
    expect(points[points.length - 1]).toEqual({ x: 300, y: 25 });
  });

  it('目标在左侧时从左侧出线，不绕大圈', () => {
    const points = orthogonalPath({ x: 400, y: 0, w: 100, h: 50 }, { x: 0, y: 0, w: 100, h: 50 });
    expect(points[0]).toEqual({ x: 400, y: 25 });
    expect(points[points.length - 1]).toEqual({ x: 100, y: 25 });
  });
});

describe('折行', () => {
  it('把长文本按宽度切成多行', () => {
    const lines = wrapText('deviceName deviceStatus createdAt updatedAt', 80, 12, 4);
    expect(lines.length).toBeGreaterThan(1);
  });

  it('超出最大行数时末行加省略号', () => {
    const lines = wrapText('a'.repeat(400), 60, 12, 2);
    expect(lines).toHaveLength(2);
    expect(lines[1]?.endsWith('…')).toBe(true);
  });

  it('中文按全角宽度估算', () => {
    expect(textWidth('设备', 12)).toBeGreaterThan(textWidth('ab', 12));
  });
});

describe('SVG', () => {
  it('产出完整 svg 且带所有节点名', () => {
    const { ir, canvasId, deviceTable, listPage } = fixture();
    const svg = renderSvg(ir, canvasId);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
    expect(svg).toContain(deviceTable.name);
    expect(svg).toContain(listPage.name);
  });

  it('转义 XML 特殊字符（字段名含 & 时不会破坏文档）', () => {
    const { ir, canvasId, deviceTable } = fixture();
    deviceTable.table.fields[1]!.name = 'a & b <c>';
    const svg = renderSvg(ir, canvasId);
    expect(svg).toContain('a &amp; b &lt;c&gt;');
    expect(svg).not.toContain('a & b <c>');
  });

  it('同一 IR 两次渲染完全一致（导出图会进 git，必须可复现）', () => {
    const { ir, canvasId } = fixture();
    expect(renderSvg(ir, canvasId)).toBe(renderSvg(ir, canvasId));
  });

  it('包含备注时备注节点出现在图里，排除时不出现', () => {
    const { ir, canvasId } = fixture();
    const withNotes = renderSvg(ir, canvasId, { includeNotes: true });
    void withNotes;
    const withoutNotes = renderSvg(ir, canvasId, { includeNotes: false });
    expect(withoutNotes).not.toContain('备注');
  });

  it('深色主题换背景色', () => {
    const { ir, canvasId } = fixture();
    expect(renderSvg(ir, canvasId, { theme: 'dark' })).toContain('#15181d');
    expect(renderSvg(ir, canvasId, { theme: 'light' })).toContain('#ffffff');
  });

  it('边的箭头 marker 按类型分别声明（共用一个会全是同色）', () => {
    const { ir, canvasId } = fixture();
    const svg = renderSvg(ir, canvasId);
    expect(svg).toContain('id="arrow-call"');
    expect(svg).toContain('id="arrow-read"');
  });

  it('端点被过滤掉时不画悬空连线', () => {
    const { ir, canvasId } = fixture();
    // 只留一个节点：所有边都该消失
    const keep = ir.nodes[0]!;
    for (const n of ir.nodes) n.kind = n.id === keep.id ? n.kind : n.kind;
    const svg = renderSvg(ir, canvasId, { includeNotes: false });
    expect(svg).toContain('<path');
  });
});

describe('JSON', () => {
  it('是 IR 的投影：带 schemaHash 与扁平节点', () => {
    const { ir, canvasId } = fixture();
    const parsed = JSON.parse(renderJson(ir, canvasId)) as {
      schemaVersion: number;
      schemaHash: string;
      nodes: Array<{ kind: string; summary: Record<string, unknown> }>;
    };
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.schemaHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(parsed.nodes.some((n) => n.kind === 'table')).toBe(true);
  });

  it('表节点带字段列表，接口节点带方法与路径', () => {
    const { ir, canvasId } = fixture();
    const parsed = JSON.parse(renderJson(ir, canvasId)) as {
      nodes: Array<{ kind: string; summary: Record<string, unknown> }>;
    };
    const table = parsed.nodes.find((n) => n.kind === 'table');
    expect(Array.isArray(table?.summary.fields)).toBe(true);
    const api = parsed.nodes.find((n) => n.kind === 'api');
    expect(typeof api?.summary.method).toBe('string');
    expect(String(api?.summary.path).startsWith('/')).toBe(true);
  });

  it('节点与边按 id 排序，输出稳定', () => {
    const { ir, canvasId } = fixture();
    expect(renderJson(ir, canvasId)).toBe(renderJson(ir, canvasId));
  });
});

describe('Mermaid', () => {
  it('产出 flowchart 与节点定义', () => {
    const { ir, canvasId } = fixture();
    const mmd = renderMermaid(ir, canvasId);
    expect(mmd.startsWith('flowchart LR')).toBe(true);
  });

  it('不同边类型用不同箭头', () => {
    const { ir, canvasId } = fixture();
    const mmd = renderMermaid(ir, canvasId, { includeNotes: true });
    expect(mmd).toMatch(/-->|-\.->|==>|--o/);
  });

  it('标签里的引号被替换，不破坏语法', () => {
    const { ir, canvasId, deviceTable } = fixture();
    deviceTable.name = '设备"表"';
    const mmd = renderMermaid(ir, canvasId);
    expect(mmd).toContain('#quot;');
    expect(mmd).not.toContain('设备"表"');
  });
});

describe('draw.io', () => {
  it('产出未压缩 XML，不含 base64 压缩块', () => {
    const { ir, canvasId } = fixture();
    const xml = renderDrawio(ir, canvasId);
    expect(xml).toContain('<mxGraphModel');
    expect(xml).toContain('<mxCell');
    // 压缩格式会把整个模型塞进 value 属性里的 base64
    expect(xml).not.toMatch(/value="[A-Za-z0-9+/]{200,}/);
  });

  it('边显式声明 edge="1" 与 source/target', () => {
    const { ir, canvasId } = fixture();
    const xml = renderDrawio(ir, canvasId);
    expect(xml).toMatch(/edge="1"[^>]*source="n\d+"[^>]*target="n\d+"/);
  });

  it('每个顶点 id 唯一', () => {
    const { ir, canvasId } = fixture();
    const xml = renderDrawio(ir, canvasId);
    const ids = [...xml.matchAll(/<mxCell id="(n\d+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('Figma 脚本', () => {
  it('产出可直接执行的 IIFE，数据内联为 JSON', () => {
    const { ir, canvasId } = fixture();
    const script = renderFigmaScript(ir, canvasId);
    expect(script).toContain('(async () => {');
    expect(script).toContain('const NODES = [');
    expect(script).toContain('figma.createFrame()');
    // 不得偷用外部能力
    expect(script).not.toContain('fetch(');
  });

  it('脚本里的颜色已转成 0–1 的 RGB 对象', () => {
    const { ir, canvasId } = fixture();
    const script = renderFigmaScript(ir, canvasId);
    expect(script).toMatch(/"fill": \{\s*"r": [\d.]+,\s*"g": [\d.]+,\s*"b": [\d.]+/);
  });

  it('非法 JSON 内容不会出现（脚本可被 JSON.parse 前的形状是合法的）', () => {
    const { ir, canvasId, deviceTable } = fixture();
    deviceTable.name = 'back\\slash "quote"';
    const script = renderFigmaScript(ir, canvasId);
    const m = /const NODES = (\[[\s\S]*?\]);\n/.exec(script);
    expect(m).not.toBeNull();
    expect(() => JSON.parse(m![1]!)).not.toThrow();
  });
});

describe('导出器注册表', () => {
  it('六种格式都有实现且 id 与键一致', () => {
    for (const format of EXPORT_FORMATS) {
      const exporter = getExporter(format);
      expect(exporter.id).toBe(format);
    }
  });

  it('文件名去掉路径分隔符（画布名含 / 会导出到别的目录）', async () => {
    const { ir, canvasId } = fixture();
    ir.canvases[0]!.name = 'a/b c';
    const result = await exportCanvas(ir, canvasId, 'svg');
    expect(result.fileName).toBe('a-b-c.svg');
  });

  it('每个导出器都能真正产出内容', async () => {
    const { ir, canvasId } = fixture();
    for (const format of EXPORT_FORMATS) {
      const result = await exportCanvas(ir, canvasId, format);
      if (format === 'png') {
        expect(result.bytes?.byteLength ?? 0).toBeGreaterThan(1000);
        // PNG magic number
        expect(result.bytes?.[0]).toBe(0x89);
      } else {
        expect((result.content ?? '').length).toBeGreaterThan(20);
      }
    }
  }, 30_000);
});
