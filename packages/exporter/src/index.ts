/**
 * 画布反向导出（TD 第 17 章）。
 *
 * 定位：导出器与编译管线并列，同属「`f(IR) → 产物`」的纯函数，**只读不写 IR**，
 * 不参与 Lint 门禁，也不影响 `schemaHash`。这条边界很重要：导出是给人看的，
 * 生成是给机器用的，混在一起会让「导出一次图」变成一次可能改变工程形态的操作。
 *
 * 不依赖 Vue Flow 实例：几何全部从 IR 的 `position`/`size` 重建，
 * 因此可在 Node 环境（CLI、CI）中运行，无需浏览器。
 */

import type { IR } from '@fsdt/core-ir';
import { renderSvg, type SvgOptions } from './svg.js';
import { renderPng, type PngOptions } from './png.js';
import { renderMermaid, type MermaidOptions } from './mermaid.js';
import { renderDrawio, type DrawioOptions } from './drawio.js';
import { renderJson, type JsonOptions } from './json.js';
import { renderFigmaScript, type FigmaOptions } from './figma.js';

export type ExportFormat = 'svg' | 'png' | 'mermaid' | 'drawio' | 'json' | 'figma';

export interface ExportOptions {
  /** 是否在节点上标注字段级端口，默认 false（避免拥挤） */
  includeFieldPorts?: boolean;
  includeNotes?: boolean;
  theme?: 'light' | 'dark';
  /** png 缩放，默认 2 */
  scale?: number;
  padding?: number;
}

export interface ExportResult {
  format: ExportFormat;
  /** 建议的文件名（不含目录） */
  fileName: string;
  /** 文本格式的产物；png 为 undefined（见 bytes） */
  content?: string;
  /** 二进制产物，仅 png */
  bytes?: Uint8Array;
  mimeType: string;
}

export interface CanvasExporter {
  readonly id: ExportFormat;
  /** png 需要光栅化依赖；其余纯字符串 */
  readonly requiresBrowser: boolean;
  readonly extension: string;
  readonly mimeType: string;
  export(ir: IR, canvasId: string, opts: ExportOptions): Promise<ExportResult>;
}

function safeFileName(name: string): string {
  // 画布名直接当文件名会把 / 和空格带进路径，导出到别处时静默失败
  return name.replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '') || 'canvas';
}

function canvasNameOf(ir: IR, canvasId: string): string {
  return ir.canvases.find((c) => c.id === canvasId)?.name ?? 'canvas';
}

const svgExporter: CanvasExporter = {
  id: 'svg',
  requiresBrowser: false,
  extension: 'svg',
  mimeType: 'image/svg+xml',
  async export(ir, canvasId, opts) {
    const options: Partial<SvgOptions> = {
      includeFieldPorts: opts.includeFieldPorts ?? false,
      includeNotes: opts.includeNotes ?? true,
      theme: opts.theme ?? 'light',
      padding: opts.padding ?? 40,
    };
    return {
      format: 'svg',
      fileName: `${safeFileName(canvasNameOf(ir, canvasId))}.svg`,
      content: renderSvg(ir, canvasId, options),
      mimeType: 'image/svg+xml',
    };
  },
};

const pngExporter: CanvasExporter = {
  id: 'png',
  // 不需要浏览器，但需要一个原生光栅化依赖；保留字段名是为了让调用方能提示用户
  requiresBrowser: false,
  extension: 'png',
  mimeType: 'image/png',
  async export(ir, canvasId, opts) {
    const options: Partial<PngOptions> = {
      includeFieldPorts: opts.includeFieldPorts ?? false,
      includeNotes: opts.includeNotes ?? true,
      theme: opts.theme ?? 'light',
      padding: opts.padding ?? 40,
      scale: opts.scale ?? 2,
    };
    return {
      format: 'png',
      fileName: `${safeFileName(canvasNameOf(ir, canvasId))}.png`,
      bytes: await renderPng(ir, canvasId, options),
      mimeType: 'image/png',
    };
  },
};

const mermaidExporter: CanvasExporter = {
  id: 'mermaid',
  requiresBrowser: false,
  extension: 'mmd',
  mimeType: 'text/plain',
  async export(ir, canvasId, opts) {
    const options: Partial<MermaidOptions> = { includeNotes: opts.includeNotes ?? false };
    return {
      format: 'mermaid',
      fileName: `${safeFileName(canvasNameOf(ir, canvasId))}.mmd`,
      content: renderMermaid(ir, canvasId, options),
      mimeType: 'text/plain',
    };
  },
};

const drawioExporter: CanvasExporter = {
  id: 'drawio',
  requiresBrowser: false,
  extension: 'drawio',
  mimeType: 'application/xml',
  async export(ir, canvasId, opts) {
    const options: Partial<DrawioOptions> = {
      includeNotes: opts.includeNotes ?? true,
      theme: opts.theme ?? 'light',
      padding: opts.padding ?? 40,
    };
    return {
      format: 'drawio',
      fileName: `${safeFileName(canvasNameOf(ir, canvasId))}.drawio`,
      content: renderDrawio(ir, canvasId, options),
      mimeType: 'application/xml',
    };
  },
};

const jsonExporter: CanvasExporter = {
  id: 'json',
  requiresBrowser: false,
  extension: 'json',
  mimeType: 'application/json',
  async export(ir, canvasId, opts) {
    const options: Partial<JsonOptions> = { includeNotes: opts.includeNotes ?? false };
    return {
      format: 'json',
      fileName: `${safeFileName(canvasNameOf(ir, canvasId))}.json`,
      content: renderJson(ir, canvasId, options),
      mimeType: 'application/json',
    };
  },
};

const figmaExporter: CanvasExporter = {
  id: 'figma',
  requiresBrowser: false,
  extension: 'figma.js',
  mimeType: 'text/javascript',
  async export(ir, canvasId, opts) {
    const options: Partial<FigmaOptions> = {
      includeNotes: opts.includeNotes ?? true,
      theme: opts.theme ?? 'light',
      padding: opts.padding ?? 40,
    };
    return {
      format: 'figma',
      fileName: `${safeFileName(canvasNameOf(ir, canvasId))}.figma.js`,
      content: renderFigmaScript(ir, canvasId, options),
      mimeType: 'text/javascript',
    };
  },
};

export const EXPORTERS: Record<ExportFormat, CanvasExporter> = {
  svg: svgExporter,
  png: pngExporter,
  mermaid: mermaidExporter,
  drawio: drawioExporter,
  json: jsonExporter,
  figma: figmaExporter,
};

export const EXPORT_FORMATS: ExportFormat[] = ['svg', 'png', 'json', 'mermaid', 'drawio', 'figma'];

export function getExporter(format: ExportFormat): CanvasExporter {
  return EXPORTERS[format];
}

export async function exportCanvas(
  ir: IR,
  canvasId: string,
  format: ExportFormat,
  options: ExportOptions = {},
): Promise<ExportResult> {
  return getExporter(format).export(ir, canvasId, options);
}

export { renderSvg, textWidth, wrapText, nodeBodyOf } from './svg.js';
export type { SvgOptions } from './svg.js';
export { renderPng } from './png.js';
export type { PngOptions } from './png.js';
export { renderMermaid } from './mermaid.js';
export type { MermaidOptions } from './mermaid.js';
export { renderDrawio } from './drawio.js';
export type { DrawioOptions } from './drawio.js';
export { renderJson, buildJsonExport } from './json.js';
export type { JsonExport, JsonExportNode, JsonExportEdge, JsonOptions } from './json.js';
export { renderFigmaScript } from './figma.js';
export type { FigmaOptions } from './figma.js';
export {
  buildGeometry,
  nodesOfCanvas,
  canvasOf,
  orthogonalPath,
  pathD,
  placedRect,
  DEFAULT_PADDING,
} from './geometry.js';
export type { Geometry, GeometryOptions, Rect, Pt } from './geometry.js';
export { LIGHT_THEME, DARK_THEME, themeOf, KIND_LABEL } from './theme.js';
export type { ExportTheme } from './theme.js';
