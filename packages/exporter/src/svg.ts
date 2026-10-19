/**
 * SVG 导出。
 *
 * 只有纯字符串拼装，不用任何模板引擎或 DOM 库：
 * SVG 就是文本，而字符串拼装是唯一能保证「同一输入 → 同一字节」的方式
 * （模板引擎的空白处理跨版本会变，那会让黄金样例永远无法稳定）。
 *
 * 两条渲染纪律：
 * 1. **文字必须手动折行**。SVG `<text>` 不换行，长字段名不处理会直接溢出节点框，
 *    而且溢出部分在 PNG 里会被裁掉，看起来像「字段消失了」。
 * 2. **字体只声明 font-family，不嵌入**。嵌入字体能让图在没装字体的机器上一致，
 *    但一个中文字体子集动辄几百 KB，导出图会从 20KB 变成 2MB，而多数评审场景
 *    是在浏览器/飞书里看，那里本来就有中文字体。
 */

import type { EdgeKind, IR, IRNode } from '@fsdt/core-ir';
import {
  centerOf,
  leftOf,
  orthogonalPath,
  pathD,
  placedRect,
  rightOf,
  round,
  buildGeometry,
  type Geometry,
  type Rect,
} from './geometry.js';
import { KIND_LABEL, themeOf, type ExportTheme } from './theme.js';

export interface SvgOptions {
  includeFieldPorts: boolean;
  includeNotes: boolean;
  theme: 'light' | 'dark';
  padding: number;
  /** 是否画出节点字段列表 */
  includeFields: boolean;
}

export const DEFAULT_SVG_OPTIONS: SvgOptions = {
  includeFieldPorts: false,
  includeNotes: true,
  theme: 'light',
  padding: 40,
  includeFields: true,
};

const EDGE_DASH: Record<EdgeKind, string> = {
  call: '',
  read: '6 4',
  write: '',
  map: '2 3',
  navigate: '10 5',
};

const EDGE_WIDTH: Record<EdgeKind, number> = {
  call: 1.75,
  read: 1.4,
  write: 1.75,
  map: 1.2,
  navigate: 1.5,
};

/** 估算文本宽度：中文按 1 个字宽、西文按 0.55 个字宽 */
export function textWidth(text: string, fontSize: number): number {
  let w = 0;
  for (const ch of text) {
    w += /[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? fontSize : fontSize * 0.55;
  }
  return w;
}

/** 按宽度折行，超出 maxLines 时末行加省略号 */
export function wrapText(text: string, maxWidth: number, fontSize: number, maxLines: number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const ch of text) {
    const next = current + ch;
    if (textWidth(next, fontSize) > maxWidth && current.length > 0) {
      lines.push(current);
      current = ch;
      if (lines.length >= maxLines) break;
    } else {
      current = next;
    }
  }
  if (lines.length < maxLines && current.length > 0) lines.push(current);
  if (lines.length === maxLines && textWidth(lines.join(''), fontSize) < textWidth(text, fontSize)) {
    const last = lines[maxLines - 1] ?? '';
    lines[maxLines - 1] = `${last.slice(0, Math.max(1, last.length - 1))}…`;
  }
  return lines;
}

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 节点标题行右侧的类型胶囊，让「这是表还是接口」一眼可辨 */
function kindBadge(theme: ExportTheme, kind: string, rect: Rect): string {
  const label = KIND_LABEL[kind] ?? kind;
  const size = 10;
  const w = textWidth(label, size) + 10;
  const x = rect.x + rect.w - w - 8;
  const y = rect.y + 8;
  return [
    `<rect x="${round(x)}" y="${round(y)}" width="${round(w)}" height="15" rx="7" fill="${theme.nodeStroke}" opacity="0.22"/>`,
    `<text x="${round(x + w / 2)}" y="${round(y + 11)}" font-family="${theme.fontFamily}" font-size="${size}" fill="${theme.mutedColor}" text-anchor="middle">${esc(label)}</text>`,
  ].join('');
}

interface NodeBody {
  title: string;
  subtitle?: string;
  lines: string[];
}

/**
 * 节点要显示的内容。
 *
 * 表节点显示字段（名字 + 类型 + 主键标记），接口节点显示方法与路径，
 * 页面节点显示路由。**这些信息全部来自 IR**，不从渲染层拿——
 * 导出必须能在没有浏览器的地方跑。
 */
export function nodeBodyOf(node: IRNode, includeFields: boolean): NodeBody {
  switch (node.kind) {
    case 'table': {
      const pk = node.table.fields[0]?.id;
      const lines = includeFields
        ? node.table.fields.map((f) => {
            const mark = f.id === pk ? '🔑 ' : '';
            const req = f.required ? '' : '?';
            return `${mark}${f.name}${req}: ${f.type}`;
          })
        : [];
      return { title: node.name, subtitle: node.table.dbName, lines };
    }
    case 'api': {
      const lines = includeFields
        ? [
            `${node.api.method} ${node.api.path}`,
            ...node.api.query.slice(0, 3).map((f) => `?${f.name}: ${f.type}`),
            ...(node.api.requestBody !== undefined
              ? node.api.requestBody.fields.slice(0, 4).map((f) => `${f.name}: ${f.type}`)
              : []),
          ]
        : [`${node.api.method} ${node.api.path}`];
      return { title: node.name, subtitle: node.codeName, lines };
    }
    case 'page': {
      const lines = includeFields ? node.page.components.slice(0, 5).map((c) => `${c.type}: ${c.id.slice(0, 8)}`) : [];
      return { title: node.name, subtitle: node.page.route, lines };
    }
    case 'note':
      return { title: '备注', lines: includeFields ? node.note.text.split('\n') : [] };
  }
}

function renderNode(theme: ExportTheme, node: IRNode, rect: Rect, opts: SvgOptions): string {
  const body = nodeBodyOf(node, opts.includeFields);
  const fill = theme.nodeFill[node.kind] ?? theme.nodeFill.table;
  const parts: string[] = [];

  parts.push(
    `<rect x="${round(rect.x)}" y="${round(rect.y)}" width="${round(rect.w)}" height="${round(rect.h)}" rx="${theme.radius}" fill="${fill}" stroke="${theme.nodeStroke}" stroke-width="1"/>`,
  );
  parts.push(kindBadge(theme, node.kind, rect));

  const innerW = rect.w - theme.padding * 2;
  const titleLines = wrapText(body.title, innerW - 60, theme.titleSize, 1);
  parts.push(
    `<text x="${round(rect.x + theme.padding)}" y="${round(rect.y + theme.padding + theme.titleSize)}" font-family="${theme.fontFamily}" font-size="${theme.titleSize}" font-weight="600" fill="${theme.titleColor}">${esc(titleLines[0] ?? '')}</text>`,
  );

  let y = rect.y + theme.padding + theme.titleSize + 4;
  if (body.subtitle !== undefined && body.subtitle.length > 0) {
    y += 4;
    const sub = wrapText(body.subtitle, innerW, theme.bodySize - 1, 1)[0] ?? '';
    parts.push(
      `<text x="${round(rect.x + theme.padding)}" y="${round(y + theme.bodySize - 1)}" font-family="${theme.fontFamily}" font-size="${theme.bodySize - 1}" fill="${theme.mutedColor}">${esc(sub)}</text>`,
    );
    y += theme.bodySize + 4;
  }

  // 字段行超过节点高度就截断：溢出部分在 PNG 里会被裁掉，看起来像字段丢了
  const maxLines = Math.max(0, Math.floor((rect.y + rect.h - theme.padding - y) / theme.lineHeight));
  for (const line of body.lines.slice(0, maxLines)) {
    parts.push(
      `<text x="${round(rect.x + theme.padding)}" y="${round(y + theme.bodySize)}" font-family="${theme.fontFamily}" font-size="${theme.bodySize}" fill="${theme.bodyColor}">${esc(line)}</text>`,
    );
    y += theme.lineHeight;
  }
  if (body.lines.length > maxLines && maxLines > 0) {
    parts.push(
      `<text x="${round(rect.x + theme.padding)}" y="${round(y + theme.bodySize)}" font-family="${theme.fontFamily}" font-size="${theme.bodySize}" fill="${theme.mutedColor}">…共 ${body.lines.length} 行</text>`,
    );
  }

  if (opts.includeFieldPorts) {
    parts.push(renderPorts(theme, node, rect));
  }
  return parts.join('\n');
}

/** 字段级端口标记：只在显式要求时画，默认关掉（节点里会很挤） */
function renderPorts(theme: ExportTheme, node: IRNode, rect: Rect): string {
  if (node.kind !== 'table' && node.kind !== 'api') return '';
  const fields = node.kind === 'table' ? node.table.fields : node.api.requestBody?.fields ?? [];
  const visible = fields.filter((f) => f.port?.visible !== false).slice(0, 12);
  const out: string[] = [];
  visible.forEach((f, i) => {
    const y = rect.y + 48 + i * theme.lineHeight;
    if (y > rect.y + rect.h - 6) return;
    out.push(`<circle cx="${round(rect.x)}" cy="${round(y)}" r="3" fill="${theme.nodeStroke}"/>`);
    out.push(`<circle cx="${round(rect.x + rect.w)}" cy="${round(y)}" r="3" fill="${theme.nodeStroke}"/>`);
  });
  return out.join('\n');
}

function edgeLabel(theme: ExportTheme, kind: EdgeKind, label: string | undefined, at: { x: number; y: number }): string {
  const text = label ?? kind;
  const w = textWidth(text, 10) + 8;
  return [
    `<rect x="${round(at.x - w / 2)}" y="${round(at.y - 8)}" width="${round(w)}" height="16" rx="3" fill="${theme.background}" opacity="0.9"/>`,
    `<text x="${round(at.x)}" y="${round(at.y + 4)}" font-family="${theme.fontFamily}" font-size="10" fill="${theme.edgeColor[kind]}" text-anchor="middle">${esc(text)}</text>`,
  ].join('');
}

export function renderSvg(ir: IR, canvasId: string, options: Partial<SvgOptions> = {}): string {
  const opts: SvgOptions = { ...DEFAULT_SVG_OPTIONS, ...options };
  const theme = themeOf(opts.theme);
  const geo = buildGeometry(ir, canvasId, { padding: opts.padding, includeNotes: opts.includeNotes });
  const rects = new Map<string, Rect>();
  for (const node of geo.nodes) rects.set(node.id, placedRect(geo, node));

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${round(geo.width)}" height="${round(geo.height)}" viewBox="0 0 ${round(geo.width)} ${round(geo.height)}">`,
  );
  parts.push(`<rect width="100%" height="100%" fill="${theme.background}"/>`);

  // 边画在节点下面：连线穿过节点时的视觉顺序更自然
  for (const edge of ir.edges.filter((e) => e.canvasId === canvasId)) {
    const a = rects.get(edge.source.nodeId);
    const b = rects.get(edge.target.nodeId);
    // 端点节点不在导出范围内（被 onlyNodeIds 过滤）时跳过这条边，
    // 而不是画一条通向 (0,0) 的线
    if (a === undefined || b === undefined) continue;
    const points = orthogonalPath(a, b);
    const color = theme.edgeColor[edge.kind];
    parts.push(
      `<path d="${pathD(points)}" fill="none" stroke="${color}" stroke-width="${EDGE_WIDTH[edge.kind]}"${EDGE_DASH[edge.kind].length > 0 ? ` stroke-dasharray="${EDGE_DASH[edge.kind]}"` : ''} marker-end="url(#arrow-${edge.kind})"/>`,
    );
    const start = rightOf(a);
    const end = leftOf(b);
    parts.push(edgeLabel(theme, edge.kind, edge.label, { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 - 4 }));
  }

  for (const node of geo.nodes) {
    if (node.kind === 'note' && !opts.includeNotes) continue;
    const rect = rects.get(node.id);
    if (rect === undefined) continue;
    parts.push(renderNode(theme, node, rect, opts));
  }

  // 箭头标记：每种边一种颜色，不能共用一个 marker（SVG marker 的 fill 是固定的）
  const markers = (Object.keys(theme.edgeColor) as EdgeKind[]).map(
    (kind) =>
      `<marker id="arrow-${kind}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="${theme.edgeColor[kind]}"/></marker>`,
  );
  parts.splice(2, 0, `<defs>${markers.join('')}</defs>`);
  parts.push('</svg>');
  void centerOf;
  void rightOf;
  return parts.join('\n');
}

export type { Geometry };
