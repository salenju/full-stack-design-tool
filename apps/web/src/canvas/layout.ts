/**
 * 自动布局：按节点类型分列，列内按当前 y 堆叠。
 *
 * 为什么不做力导向/层次布局：画布的语义是「按职责分列」——表在左、接口居中、
 * 页面在右，读起来就是一条从左到右的链路。力导向会把表甩到页面右边，
 * 而 dagre 那类层次布局会把「同层但无关」的节点并排，反而看不出流向。
 *
 * 高度靠估算而不是测 DOM：布局要在一次 mutate 里算完所有位置，
 * 读 DOM 会强制同步布局，节点一多就卡。
 */
import type { IRNode } from '@fsdt/core-ir';

const COLUMN_OF: Record<string, number> = { table: 0, api: 1, page: 2, note: 3 };
const COLUMN_X = 80;
const COLUMN_GAP = 60;
const NODE_WIDTH = 272;
const START_Y = 60;
const ROW_GAP = 44;

function estimateHeight(node: IRNode): number {
  const head = 46;
  switch (node.kind) {
    case 'table':
      return head + node.table.fields.length * 21 + 8;
    case 'api': {
      const rows =
        node.api.query.length + (node.api.requestBody?.fields.length ?? 0) + (node.api.responses[0]?.fields.length ?? 0);
      const sections = [node.api.query.length, node.api.requestBody?.fields.length ?? 0, node.api.responses[0]?.fields.length ?? 0].filter(
        (n) => n > 0,
      ).length;
      return head + 22 + sections * 20 + rows * 20 + 8;
    }
    case 'page':
      return head + node.page.components.length * 21 + 8;
    default:
      return 90 + Math.ceil(node.note.text.length / 24) * 18;
  }
}

export interface LayoutResult {
  id: string;
  position: { x: number; y: number };
}

export function autoLayout(nodes: IRNode[]): LayoutResult[] {
  const columns = new Map<number, IRNode[]>();
  for (const node of nodes) {
    const column = COLUMN_OF[node.kind] ?? 0;
    const list = columns.get(column) ?? [];
    list.push(node);
    columns.set(column, list);
  }

  const out: LayoutResult[] = [];
  for (const [column, list] of [...columns.entries()].sort((a, b) => a[0] - b[0])) {
    const sorted = [...list].sort((a, b) => a.position.y - b.position.y || a.name.localeCompare(b.name));
    let y = START_Y;
    for (const node of sorted) {
      out.push({
        id: node.id,
        position: { x: COLUMN_X + column * (NODE_WIDTH + COLUMN_GAP), y: Math.round(y) },
      });
      y += estimateHeight(node) + ROW_GAP;
    }
  }
  return out;
}
