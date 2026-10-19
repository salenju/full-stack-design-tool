/**
 * draw.io 导出（P1）。
 *
 * 输出**未压缩的 XML**（`<mxGraphModel>` 直接包 `<mxCell>`），不用 draw.io 的
 * 压缩格式（base64 + deflate）。理由：
 * - 未压缩 XML 可以直接 diff、可以贴进 issue、可以人工检查生成器对不对；
 * - 压缩格式一旦出问题，用户拿到的就是一串乱码，连「哪一步错了」都无法定位；
 * - 文件大一点（几十 KB）对能打开 draw.io 的人来说完全无感。
 *
 * 一个 draw.io 特有的坑：**所有 cell 的 id 必须是字符串且唯一**，边必须显式声明
 * `edge="1"` 并给出 source/target，否则 draw.io 会把它当成孤立顶点（显示成一个点）。
 */

import type { EdgeKind, IR, IRNode } from '@fsdt/core-ir';
import { nodesOfCanvas, placedRect, buildGeometry } from './geometry.js';
import { themeOf, KIND_LABEL } from './theme.js';

export interface DrawioOptions {
  includeNotes: boolean;
  theme: 'light' | 'dark';
  padding: number;
}

export const DEFAULT_DRAWIO_OPTIONS: DrawioOptions = { includeNotes: true, theme: 'light', padding: 40 };

const EDGE_STYLE: Record<EdgeKind, string> = {
  call: 'edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=block;endFill=1;',
  read: 'edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;dashed=1;endArrow=open;endFill=0;',
  write: 'edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;strokeWidth=2;endArrow=block;endFill=1;',
  map: 'edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;dashed=1;dashPattern=2 3;endArrow=none;',
  navigate: 'edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;dashed=1;dashPattern=10 5;endArrow=open;endFill=0;',
};

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/\n/g, '&#10;');
}

/** draw.io 的富文本用的是 HTML，`html=1` 时 label 里的换行要写成 <br> */
function htmlLabel(node: IRNode): string {
  if (node.kind === 'table') {
    const fields = node.table.fields.slice(0, 10).map((f) => `${esc(f.name)}: ${esc(f.type)}`);
    return [`<b>${esc(node.name)}</b>`, `<i>${esc(node.table.dbName)}</i>`, ...fields].join('<br>');
  }
  if (node.kind === 'api') {
    return [`<b>${esc(node.name)}</b>`, `${esc(node.api.method)} ${esc(node.api.path)}`].join('<br>');
  }
  if (node.kind === 'page') return [`<b>${esc(node.name)}</b>`, esc(node.page.route)].join('<br>');
  return esc(node.note.text);
}

export function renderDrawio(ir: IR, canvasId: string, options: Partial<DrawioOptions> = {}): string {
  const opts: DrawioOptions = { ...DEFAULT_DRAWIO_OPTIONS, ...options };
  const theme = themeOf(opts.theme);
  const geo = buildGeometry(ir, canvasId, { padding: opts.padding, includeNotes: opts.includeNotes });
  const nodes = geo.nodes.filter((n) => opts.includeNotes || n.kind !== 'note');
  const visible = new Set(nodes.map((n) => n.id));

  const cells: string[] = [
    '<mxCell id="0" />',
    '<mxCell id="1" parent="0" />',
  ];

  let idx = 0;
  const cellIdOf = new Map<string, string>();
  for (const node of nodes) {
    const rect = placedRect(geo, node);
    const id = `n${idx++}`;
    cellIdOf.set(node.id, id);
    const fill = theme.nodeFill[node.kind] ?? theme.nodeFill.table;
    const shape = node.kind === 'page' ? 'shape=document;' : node.kind === 'api' ? 'rounded=1;arcSize=8;' : 'rounded=0;';
    const style = `${shape}whiteSpace=wrap;html=1;fillColor=${fill};strokeColor=${theme.nodeStroke};fontColor=${theme.titleColor};align=left;verticalAlign=top;spacingLeft=8;spacingTop=6;`;
    cells.push(
      `<mxCell id="${id}" value="${esc(htmlLabel(node))}" style="${style}" vertex="1" parent="1"><mxGeometry x="${rect.x}" y="${rect.y}" width="${rect.w}" height="${rect.h}" as="geometry" /></mxCell>`,
    );
    void KIND_LABEL;
  }

  let eidx = 0;
  for (const edge of ir.edges.filter((e) => e.canvasId === canvasId)) {
    if (!visible.has(edge.source.nodeId) || !visible.has(edge.target.nodeId)) continue;
    const source = cellIdOf.get(edge.source.nodeId);
    const target = cellIdOf.get(edge.target.nodeId);
    if (source === undefined || target === undefined) continue;
    const color = theme.edgeColor[edge.kind];
    const style = `${EDGE_STYLE[edge.kind]}strokeColor=${color};fontColor=${color};fontSize=10;`;
    cells.push(
      `<mxCell id="e${eidx++}" value="${esc(edge.label ?? edge.kind)}" style="${style}" edge="1" parent="1" source="${source}" target="${target}"><mxGeometry relative="1" as="geometry" /></mxCell>`,
    );
  }

  const width = Math.round(geo.width);
  const height = Math.round(geo.height);
  return [
    '<mxGraphModel dx="1422" dy="798" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1169" pageHeight="827" math="0" shadow="0">',
    '  <root>',
    ...cells.map((c) => `    ${c}`),
    '  </root>',
    '</mxGraphModel>',
    `<!-- 画布导出尺寸 ${width} × ${height}；由 fsdt exporter 生成 -->`,
    '',
  ].join('\n');
}
