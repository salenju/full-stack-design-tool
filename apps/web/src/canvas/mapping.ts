/**
 * IR ↔ Vue Flow 的映射。
 *
 * 单向数据流：Vue Flow 拿到的 nodes/edges 全部从 IR 派生，
 * 它自己的内部状态只用于拖拽过程中的临时坐标。凡是需要持久化的变更
 * 都回到 store.mutate，这样撤销栈和自动保存只有一个入口。
 */
import { MarkerType } from '@vue-flow/core';
import type { Edge, Node } from '@vue-flow/core';

import type { EdgeKind, Field, IR, IRNode, NodeKind } from '@fsdt/core-ir';

export interface FlowNodeData {
  kind: NodeKind;
  node: IRNode;
  /** 端口模式打开时渲染全部字段，否则只渲染前 N 个 */
  showAllPorts: boolean;
}

export const NODE_WIDTH = 272;
/** 折叠时显示的字段行数，和 TD 4.2 的「前 5 个 + N 徽标」一致 */
export const PORT_PREVIEW = 5;

export const NODE_LABEL: Record<NodeKind, string> = {
  table: '表',
  api: '接口',
  page: '页面',
  note: '备注',
};

export const EDGE_LABEL: Record<EdgeKind, string> = {
  call: '调用',
  read: '读取',
  write: '写入',
  map: '映射',
  navigate: '跳转',
};

export const EDGE_STYLE: Record<EdgeKind, { color: string; dash?: string; width: number }> = {
  call: { color: '#6366f1', width: 1.8 },
  read: { color: '#3b82f6', dash: '6 4', width: 1.6 },
  write: { color: '#f59e0b', width: 1.8 },
  map: { color: '#94a3b8', width: 1.2 },
  navigate: { color: '#10b981', dash: '2 4', width: 1.6 },
};

export function fieldsOf(node: IRNode): Field[] {
  switch (node.kind) {
    case 'table':
      return node.table.fields;
    case 'api':
      return [...node.api.query, ...(node.api.requestBody?.fields ?? []), ...(node.api.responses[0]?.fields ?? [])];
    default:
      return [];
  }
}

export function toFlowNodes(ir: IR, showAllPorts: boolean): Node<FlowNodeData>[] {
  return ir.nodes.map((node) => ({
    id: node.id,
    type: node.kind,
    position: { x: node.position.x, y: node.position.y },
    data: { kind: node.kind, node, showAllPorts },
    selected: false,
  }));
}

export function toFlowEdges(ir: IR): Edge[] {
  return ir.edges.map((edge) => {
    const style = EDGE_STYLE[edge.kind];
    return {
      id: edge.id,
      source: edge.source.nodeId,
      target: edge.target.nodeId,
      ...(edge.source.fieldId !== undefined ? { sourceHandle: `out:${edge.source.fieldId}` } : {}),
      ...(edge.target.fieldId !== undefined ? { targetHandle: `in:${edge.target.fieldId}` } : {}),
      type: 'default',
      label: edge.label ?? EDGE_LABEL[edge.kind],
      labelStyle: { fill: style.color, fontSize: '10px', fontWeight: 600 },
      labelBgStyle: { fill: '#ffffff', fillOpacity: 0.9 },
      style: {
        stroke: style.color,
        strokeWidth: style.width,
        ...(style.dash !== undefined ? { strokeDasharray: style.dash } : {}),
      },
      markerEnd: { type: MarkerType.ArrowClosed, color: style.color, width: 14, height: 14 },
      data: { kind: edge.kind },
    };
  });
}

/** 从一个连接动作推断边类型：能自动判断的就不让用户再选一次 */
export function inferEdgeKind(
  sourceKind: NodeKind | undefined,
  targetKind: NodeKind | undefined,
  bothFieldLevel: boolean,
): EdgeKind {
  if (sourceKind === 'page' && targetKind === 'api') return 'call';
  if (sourceKind === 'page' && targetKind === 'page') return 'navigate';
  if (sourceKind === 'api' && targetKind === 'table') return 'read';
  if (sourceKind === 'table' && targetKind === 'api') return 'write';
  if (bothFieldLevel) return 'map';
  return 'call';
}
