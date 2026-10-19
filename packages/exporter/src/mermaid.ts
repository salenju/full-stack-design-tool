/**
 * Mermaid 导出（P1）。
 *
 * 为什么值得做：Mermaid 能直接贴进飞书文档、Notion、GitHub PR 描述并被渲染成图。
 * 「把画布贴进评审文档」是这个工具最高频的协作场景之一，而贴 PNG 的问题是不能
 * 复制文字、不能搜索、改一个字段就得重新导出。
 *
 * 两个必须处理的 Mermaid 语法坑：
 * 1. **节点 ID 不能含特殊字符**。IR 的 `nd_xxxx` 是安全的，但用户给的名字可以是
 *    任何字符，所以标签一律用 `["..."]` 包起来并转义引号。
 * 2. **`end` 之类关键字会让解析器崩**。标签里出现 `end`/`subgraph` 时整张图报解析
 *    错误，而错误信息不会指出是哪个节点——所以统一加引号能规避绝大多数情况。
 */

import type { EdgeKind, IR } from '@fsdt/core-ir';
import { nodesOfCanvas } from './geometry.js';

export interface MermaidOptions {
  includeNotes: boolean;
  direction: 'LR' | 'TB';
}

export const DEFAULT_MERMAID_OPTIONS: MermaidOptions = { includeNotes: false, direction: 'LR' };

/** 不同边类型用不同箭头，与画布上的语义一致 */
const ARROW: Record<EdgeKind, string> = {
  call: '-->',
  read: '-.->',
  write: '==>',
  map: '--o',
  navigate: '-.->',
};

function label(text: string): string {
  // Mermaid 的引号标签里 " 必须换成 #quot;，"<"">" 也要换，否则会破坏语法
  return `"${text.replace(/"/g, '#quot;').replace(/</g, '#lt;').replace(/>/g, '#gt;')}"`;
}

/** 节点内要显示的多行文本：Mermaid 用 `<br/>` 换行 */
function nodeTextOf(node: Parameters<typeof nodeBodyLike>[0]): string {
  if (node.kind === 'table') {
    const fields = node.table.fields.slice(0, 8).map((f) => `${f.name}: ${f.type}`);
    return [node.name, ...fields].join('<br/>');
  }
  if (node.kind === 'api') return [node.name, `${node.api.method} ${node.api.path}`].join('<br/>');
  if (node.kind === 'page') return [node.name, node.page.route].join('<br/>');
  return node.note.text.slice(0, 80);
}

type NodeLike = ReturnType<typeof nodesOfCanvas>[number];
function nodeBodyLike(node: NodeLike) {
  return node;
}

export function renderMermaid(ir: IR, canvasId: string, options: Partial<MermaidOptions> = {}): string {
  const opts: MermaidOptions = { ...DEFAULT_MERMAID_OPTIONS, ...options };
  const nodes = nodesOfCanvas(ir, canvasId).filter((n) => opts.includeNotes || n.kind !== 'note');
  const visible = new Set(nodes.map((n) => n.id));

  const lines: string[] = [`flowchart ${opts.direction}`];

  // 节点形状按类型区分：表=矩形、接口=圆角、页面=旗标、备注=文档形
  for (const node of nodes) {
    const text = nodeTextOf(node);
    const id = node.id;
    if (node.kind === 'table') lines.push(`  ${id}[${label(text)}]`);
    else if (node.kind === 'api') lines.push(`  ${id}(${label(text)})`);
    else if (node.kind === 'page') lines.push(`  ${id}>${label(text)}]`);
    else lines.push(`  ${id}[/${label(text)}/]`);
  }

  for (const edge of ir.edges.filter((e) => e.canvasId === canvasId)) {
    // 端点被过滤掉（备注节点）时跳过，否则 Mermaid 会凭空造两个空节点
    if (!visible.has(edge.source.nodeId) || !visible.has(edge.target.nodeId)) continue;
    const arrow = ARROW[edge.kind];
    const text = edge.label ?? edge.kind;
    lines.push(`  ${edge.source.nodeId} ${arrow}|${label(text)}| ${edge.target.nodeId}`);
  }

  return `${lines.join('\n')}\n`;
}
