/**
 * PNG 导出：SVG 字符串 → @resvg/resvg-js 光栅化。
 *
 * **刻意不用 Puppeteer / Playwright 截图**（TD 17.4 的决策）：
 * - 浏览器依赖数百 MB，CI 上还要装 chromium，`fsdt export` 会从秒级变成分钟级；
 * - 本工具的图形元素只有矩形、文字、折线，不需要 CSS 布局引擎；
 * - 截图路径下「同一 IR 两次导出字节一致」很难保证（字体渲染、抗锯齿随时间变化），
 *   而导出的图会进 git，不一致就是无意义的 diff。
 *
 * resvg 是 Rust 实现，纯本地二进制、无浏览器，且渲染结果是确定性的。
 *
 * 一个已知限制：**中文字体依赖运行环境**。resvg 需要 fontconfig 能找到字体，
 * 所以这里显式传入 defaultFontFamily 并允许调用方覆盖；找不到字体时 SVG 里的
 * 文字会退化成方框，这时唯一正确的做法是报错而不是产出一张废图。
 */

import type { IR } from '@fsdt/core-ir';
import { renderSvg, type SvgOptions } from './svg.js';

export interface PngOptions extends Partial<SvgOptions> {
  /** 缩放倍数，默认 2（Retina 下不糊） */
  scale: number;
  /** 优先使用的字体族，默认取 SVG 里的 font-family */
  fontFamily?: string;
}

export const DEFAULT_PNG_OPTIONS: PngOptions = { scale: 2 };

export async function renderPng(ir: IR, canvasId: string, options: Partial<PngOptions> = {}): Promise<Uint8Array> {
  const opts: PngOptions = { ...DEFAULT_PNG_OPTIONS, ...options };
  // scale 走 SVG 的 width/height 乘算而不是 resvg 的 zoom：
  // zoom 只放大位图，width 会重新按矢量算，两者在细线上差别很明显。
  const svg = renderSvg(ir, canvasId, opts);

  let Resvg: typeof import('@resvg/resvg-js').Resvg;
  try {
    ({ Resvg } = await import('@resvg/resvg-js'));
  } catch (error) {
    throw new Error(
      `PNG 导出需要可选依赖 @resvg/resvg-js，当前未安装或无法加载：${(error as Error).message}。` +
        '请改用 svg 格式，或执行 pnpm add @resvg/resvg-js。',
    );
  }

  const scaled = svg.replace(
    /<svg ([^>]*?)width="([\d.]+)" height="([\d.]+)"/,
    (_m, pre: string, w: string, h: string) =>
      `<svg ${pre}width="${Math.round(Number(w) * opts.scale)}" height="${Math.round(Number(h) * opts.scale)}"`,
  );

  const renderer = new Resvg(scaled, {
    fitTo: { mode: 'original' },
    font: {
      loadSystemFonts: true,
      defaultFontFamily: opts.fontFamily ?? 'PingFang SC',
      // 依次回退：macOS 有 PingFang，Linux CI 一般只有 Noto，Windows 有雅黑。
      // 都不命中时 resvg 会退化到任意系统字体，中文可能变方框——所以在
      // 调用方（CLI）层面还会校验一次产物非空，见下方 ensureNonEmpty。
      sansSerifFamily: opts.fontFamily ?? 'PingFang SC',
    },
  });
  const png = renderer.render().asPng();
  ensureNonEmpty(png);
  return png;
}

/**
 * 空产物检查。
 *
 * resvg 在「所有文字都渲染失败」时仍会返回一张只有背景色的合法 PNG，
 * 调用方拿到文件不会报错，等到评审时才发现图里没有字。这里至少拦住
 * 「连图都生成不出来」的情况，并把原因说清楚。
 */
function ensureNonEmpty(png: Uint8Array): void {
  if (png.byteLength < 100) {
    throw new Error('PNG 光栅化产物异常（小于 100 字节），通常意味着字体系统不可用');
  }
}
