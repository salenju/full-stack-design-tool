/**
 * Figma 导出（P1）：生成一段可粘进 Figma 插件控制台执行的 JS。
 *
 * **不直接调 Figma REST API**（TD 17.3 的决策），三个理由：
 * 1. 写 API 需要 `file_content:write` 权限，而这个权限在企业 Figma 里通常只有管理员
 *    能授予——让每个用户去申请权限，工具就死在这一步；
 * 2. Figma REST 有速率限制（尤其写入类），一个 50 节点的画布可能要分几十次请求；
 * 3. 插件脚本能在用户当前打开的**任意**文件里创建 frame，包括还没保存的新文件，
 *    而 REST 必须先有一个 fileKey。
 *
 * 代价是用户需要手动粘一次，但这是一次性动作，且失败时错误信息直接出现在 Figma 里，
 * 比「HTTP 403」好排查得多。
 *
 * 脚本里刻意不使用任何外部 API（不 fetch、不 import），只用 Figma Plugin API 的
 * `figma.createFrame` / `createText` / `createLine`，这样在插件的 `eval` 环境里能直接跑。
 */

import type { EdgeKind, IR } from '@fsdt/core-ir';
import { buildGeometry, placedRect } from './geometry.js';
import { KIND_LABEL, themeOf } from './theme.js';

export interface FigmaOptions {
  includeNotes: boolean;
  theme: 'light' | 'dark';
  padding: number;
  /** 生成 frame 的名称 */
  frameName?: string;
}

export const DEFAULT_FIGMA_OPTIONS: FigmaOptions = {
  includeNotes: true,
  theme: 'light',
  padding: 40,
};

const EDGE_COLOR: Record<EdgeKind, string> = {
  call: '#2f6fd0',
  read: '#2f9e6b',
  write: '#c2410c',
  map: '#7c5cd6',
  navigate: '#b08a00',
};

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const value = hex.replace('#', '');
  return {
    r: parseInt(value.slice(0, 2), 16) / 255,
    g: parseInt(value.slice(2, 4), 16) / 255,
    b: parseInt(value.slice(4, 6), 16) / 255,
  };
}

export function renderFigmaScript(ir: IR, canvasId: string, options: Partial<FigmaOptions> = {}): string {
  const opts: FigmaOptions = { ...DEFAULT_FIGMA_OPTIONS, ...options };
  const theme = themeOf(opts.theme);
  const canvas = ir.canvases.find((c) => c.id === canvasId);
  if (canvas === undefined) throw new Error(`画布不存在：${canvasId}`);
  const geo = buildGeometry(ir, canvasId, { padding: opts.padding, includeNotes: opts.includeNotes });
  const nodes = geo.nodes.filter((n) => opts.includeNotes || n.kind !== 'note');

  const nodeData = nodes.map((node) => {
    const rect = placedRect(geo, node);
    const body =
      node.kind === 'table'
        ? node.table.fields.slice(0, 12).map((f) => `${f.name}: ${f.type}`).join('\n')
        : node.kind === 'api'
          ? `${node.api.method} ${node.api.path}`
          : node.kind === 'page'
            ? node.page.route
            : node.note.text;
    return {
      id: node.id,
      label: node.name,
      kindLabel: KIND_LABEL[node.kind] ?? node.kind,
      x: rect.x,
      y: rect.y,
      w: rect.w,
      h: rect.h,
      fill: hexToRgb(theme.nodeFill[node.kind] ?? theme.nodeFill.table ?? '#ffffff'),
      body,
    };
  });

  const edgeData = ir.edges
    .filter((e) => e.canvasId === canvasId)
    .filter((e) => nodes.some((n) => n.id === e.source.nodeId) && nodes.some((n) => n.id === e.target.nodeId))
    .map((e) => ({
      kind: e.kind,
      label: e.label ?? e.kind,
      color: hexToRgb(EDGE_COLOR[e.kind]),
      from: e.source.nodeId,
      to: e.target.nodeId,
    }));

  const frameName = opts.frameName ?? `${ir.project.name} / ${canvas.name}`;
  const width = Math.round(geo.width);
  const height = Math.round(geo.height);

  // 生成的是完整可执行脚本。所有数据以 JSON 字面量内联，脚本本身不含逻辑之外的依赖。
  return `/**
 * 由 fsdt exporter 生成的 Figma 脚本（${canvas.name}，${width}×${height}）。
 *
 * 用法：Figma → 菜单 Plugins → Development → Show/Hide console → 粘贴执行。
 * 会在当前页面新建一个 frame，不改动已有内容。
 */
(async () => {
  const NODES = ${JSON.stringify(nodeData, null, 2)};
  const EDGES = ${JSON.stringify(edgeData, null, 2)};
  const FRAME_NAME = ${JSON.stringify(frameName)};
  const SIZE = { width: ${width}, height: ${height} };
  const RECTS = new Map(NODES.map((n) => [n.id, n]));

  await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
  await figma.loadFontAsync({ family: 'Inter', style: 'Bold' });

  const frame = figma.createFrame();
  frame.name = FRAME_NAME;
  frame.resize(SIZE.width, SIZE.height);
  frame.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];

  for (const node of NODES) {
    const box = figma.createRectangle();
    box.name = node.label;
    box.x = node.x;
    box.y = node.y;
    box.resize(node.w, node.h);
    box.cornerRadius = 6;
    box.fills = [{ type: 'SOLID', color: node.fill }];
    box.strokes = [{ type: 'SOLID', color: { r: 0.79, g: 0.81, b: 0.84 } }];
    frame.appendChild(box);

    const title = figma.createText();
    title.fontName = { family: 'Inter', style: 'Bold' };
    title.characters = node.label;
    title.fontSize = 14;
    title.x = node.x + 10;
    title.y = node.y + 10;
    frame.appendChild(title);

    const body = figma.createText();
    body.fontName = { family: 'Inter', style: 'Regular' };
    body.characters = node.body;
    body.fontSize = 12;
    body.x = node.x + 10;
    body.y = node.y + 34;
    frame.appendChild(body);
  }

  for (const edge of EDGES) {
    const from = RECTS.get(edge.from);
    const to = RECTS.get(edge.to);
    if (!from || !to) continue;
    const line = figma.createLine();
    line.x = from.x + from.w;
    line.y = from.y + from.h / 2;
    line.resize(Math.max(1, to.x - (from.x + from.w)), 0);
    line.strokes = [{ type: 'SOLID', color: edge.color }];
    frame.appendChild(line);
  }

  figma.viewport.scrollAndZoomIntoView([frame]);
  figma.notify('已导入画布：' + FRAME_NAME + '（' + NODES.length + ' 个节点）');
})();
`;
}
