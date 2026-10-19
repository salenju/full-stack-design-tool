/**
 * 从 IR 重建画布几何。
 *
 * 关键约束：**不依赖 Vue Flow 实例**。导出要能在 CLI / CI 里跑（`fsdt export`），
 * 那里没有 DOM。所以节点位置一律取自 IR 的 `position`/`size`，边一律靠端点
 * 重新算路，绝不去问渲染层「你画在哪」。
 *
 * 这也是「画布状态归 IR、渲染层只是视图」的直接好处：同一份 IR 在浏览器里
 * 和 Node 里导出的图必须一模一样。
 */

import type { Canvas, IR, IRNode } from '@fsdt/core-ir';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Pt {
  x: number;
  y: number;
}

export interface GeometryOptions {
  padding: number;
  /** 是否把备注节点计入包围盒（不导出备注时也不该被它撑大画布） */
  includeNotes: boolean;
  /** 指定导出范围为其子集（按 ID）；为空表示整个画布 */
  onlyNodeIds?: Set<string>;
}

export interface Geometry {
  nodes: IRNode[];
  bounds: Rect;
  width: number;
  height: number;
  /** IR 坐标 → 导出坐标（加上 padding 并平移到原点） */
  translate(p: Pt): Pt;
  rectOf(node: IRNode): Rect;
}

export const DEFAULT_PADDING = 40;

export function nodesOfCanvas(ir: IR, canvasId: string): IRNode[] {
  return ir.nodes.filter((n) => n.canvasId === canvasId);
}

export function canvasOf(ir: IR, canvasId: string): Canvas {
  const canvas = ir.canvases.find((c) => c.id === canvasId);
  if (canvas === undefined) throw new Error(`画布不存在：${canvasId}`);
  return canvas;
}

/**
 * 空画布的兜底尺寸。
 *
 * 不返回 0×0：`<svg width="0">` 在部分渲染器里直接报错或产出空白文件，
 * 而且用户看到「导出成功但文件打不开」比看到「导出的是 200×120 的空白图」更困惑。
 */
const EMPTY_WIDTH = 200;
const EMPTY_HEIGHT = 120;

export function buildGeometry(ir: IR, canvasId: string, options: GeometryOptions): Geometry {
  const all = nodesOfCanvas(ir, canvasId);
  const nodes = options.onlyNodeIds === undefined ? all : all.filter((n) => options.onlyNodeIds!.has(n.id));
  const measurable = options.includeNotes ? nodes : nodes.filter((n) => n.kind !== 'note');

  const rectOf = (node: IRNode): Rect => ({ x: node.position.x, y: node.position.y, w: node.size.w, h: node.size.h });

  let minX = 0;
  let minY = 0;
  let maxX = EMPTY_WIDTH;
  let maxY = EMPTY_HEIGHT;

  if (measurable.length > 0) {
    const rects = measurable.map(rectOf);
    minX = Math.min(...rects.map((r) => r.x));
    minY = Math.min(...rects.map((r) => r.y));
    maxX = Math.max(...rects.map((r) => r.x + r.w));
    maxY = Math.max(...rects.map((r) => r.y + r.h));
  }

  const pad = options.padding;
  const bounds: Rect = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  return {
    nodes,
    bounds,
    width: bounds.w + pad * 2,
    height: bounds.h + pad * 2,
    translate: (p) => ({ x: p.x - bounds.x + pad, y: p.y - bounds.y + pad }),
    rectOf,
  };
}

/** 节点在导出坐标系里的矩形 */
export function placedRect(geo: Geometry, node: IRNode): Rect {
  const local = geo.rectOf(node);
  const p = geo.translate({ x: local.x, y: local.y });
  return { x: p.x, y: p.y, w: local.w, h: local.h };
}

export function centerOf(r: Rect): Pt {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

export function leftOf(r: Rect): Pt {
  return { x: r.x, y: r.y + r.h / 2 };
}

export function rightOf(r: Rect): Pt {
  return { x: r.x + r.w, y: r.y + r.h / 2 };
}

export function topOf(r: Rect): Pt {
  return { x: r.x + r.w / 2, y: r.y };
}

export function bottomOf(r: Rect): Pt {
  return { x: r.x + r.w / 2, y: r.y + r.h };
}

/**
 * 正交连线：从 a 到 b 走两段折线，拐点在两列之间。
 *
 * 为什么不用直线：画布上节点成列摆放，直线会穿过中间一整列节点上的文字。
 * 正交路由的额外价值是「横平竖直」本身就传达了「这是一条数据流」。
 *
 * 为什么拐点放中点而不是固定偏移：节点宽度差异很大（表节点 320、备注 200），
 * 固定偏移会在窄节点之间拐到框外。
 */
export function orthogonalPath(a: Rect, b: Rect): Pt[] {
  const from = rightOf(a);
  const to = leftOf(b);
  // 目标在左侧时从左边出线，否则连线会绕一大圈包住两个节点
  const back = to.x < from.x;
  const start = back ? leftOf(a) : from;
  const end = back ? rightOf(b) : to;
  const midX = (start.x + end.x) / 2;
  return [start, { x: midX, y: start.y }, { x: midX, y: end.y }, end];
}

export function pathD(points: Pt[]): string {
  return points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${round(p.x)} ${round(p.y)}`)
    .join(' ');
}

/** 所有坐标统一保留 1 位小数：避免浮点尾数让 diff 每次都不同 */
export function round(value: number): number {
  return Math.round(value * 10) / 10;
}
