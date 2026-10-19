/**
 * 区块标记与文件头。
 *
 * 这是「生成代码与手写代码共存」的全部机制——没有它，用户改了生成的页面之后
 * 就再也不敢重新生成，工具的价值在第一次手工修改后归零。
 *
 * 标记语法刻意用注释：
 * ```ts
 * // @dsg:generated start name=columns hash=abc123
 * const columns = [...]
 * // @dsg:generated end name=columns
 * ```
 * - 生成器写出的区块用 `generated`，用户想保留的区块手工改成 `handwritten`。
 * - `todo` 区块由 AI 填充或人工补全，重新生成时不清空。
 * - `hash` 是区块内容的 sha256 前 16 位，用于判断「用户是否改过这段」。
 */

import { hashRegion } from '@fsdt/core-ir';

import type { Language, RegionMode } from './types.js';

const COMMENT_PREFIX: Record<Language, string> = {
  ts: '//',
  vue: '<!--',
  prisma: '//',
  json: '//',
  css: '/*',
  md: '<!--',
  html: '<!--',
  env: '#',
};

function comment(language: Language, text: string): string {
  switch (language) {
    case 'css':
      return `/* ${text} */`;
    case 'vue':
    case 'md':
    case 'html':
      return `<!-- ${text} -->`;
    case 'env':
      return `# ${text}`;
    default:
      return `// ${text}`;
  }
}

export interface RegionOptions {
  name: string;
  mode?: RegionMode;
}

/** 返回 [开始标记, 结束标记]，内容由调用方写在两者之间 */
export function regionMarkers(language: Language, options: RegionOptions): { start: string; end: string } {
  const mode = options.mode ?? 'generated';
  return {
    start: comment(language, `@dsg:${mode} start name=${options.name}`),
    end: comment(language, `@dsg:${mode} end name=${options.name}`),
  };
}

/** 带哈希的开始标记：内容变化时哈希也变，便于三方合并 */
export function regionStart(language: Language, name: string, content: string, mode: RegionMode = 'generated'): string {
  return comment(language, `@dsg:${mode} start name=${name} hash=${hashRegion(content)}`);
}

export function regionEnd(language: Language, name: string, mode: RegionMode = 'generated'): string {
  return comment(language, `@dsg:${mode} end name=${name}`);
}

/** 把内容包进区块标记 */
export function wrapRegion(
  language: Language,
  name: string,
  content: string,
  mode: RegionMode = 'generated',
): string {
  return [regionStart(language, name, content, mode), content, regionEnd(language, name, mode)].join('\n');
}

export interface FileHeaderOptions {
  language: Language;
  /** 相对输出根的路径 */
  path: string;
  /** 来源节点 ID 列表 */
  nodeIds: string[];
  /** IR 语义哈希，用于「契约已变，请人工检查」提示 */
  irHash: string;
  generator: string;
  generatorVersion: string;
}

/**
 * 文件头。
 *
 * 三个字段缺一不可：
 * - `node=` 让 `fsdt gen --check` 能反查「这个文件是哪个节点生成的」；
 * - `ir=` 让工具能判断「契约变了但这个文件没重生成」；
 * - `generator=` 让升级生成器后能定位需要重新生成的文件。
 */
export function fileHeader(options: FileHeaderOptions): string {
  const { language } = options;
  const parts = [
    `@dsg:generated file=${options.path}`,
    `node=${options.nodeIds.length > 0 ? options.nodeIds.join(',') : '-'}`,
    `ir=${options.irHash}`,
    `generator=${options.generator}@${options.generatorVersion}`,
  ];
  const text = parts.join(' ');

  if (language === 'vue') {
    // Vue 单文件组件的头注释必须放在最外层，不能进 template
    return `<!-- ${text} -->`;
  }
  return comment(language, text);
}

export const DO_NOT_EDIT_NOTICE =
  '此文件由 @fsdt 生成。手写内容请放进 @dsg:handwritten 区块，否则重新生成时会被覆盖。';

/** 解析文本里的全部区块（CLI 的漂移检测与三方合并用） */
export interface ParsedRegion {
  name: string;
  mode: RegionMode;
  hash?: string;
  startLine: number;
  endLine: number;
  content: string;
}

const REGION_RE = /@dsg:(generated|handwritten|todo)\s+(start|end)\s+name=([A-Za-z0-9_.-]+)(?:\s+hash=([0-9a-f]+))?/;

export function parseRegions(text: string): ParsedRegion[] {
  const lines = text.split('\n');
  const regions: ParsedRegion[] = [];
  const open = new Map<string, { mode: RegionMode; hash?: string; startLine: number }>();

  for (let i = 0; i < lines.length; i += 1) {
    const m = REGION_RE.exec(lines[i]!);
    if (m === null) continue;
    const mode = m[1] as RegionMode;
    const kind = m[2];
    const name = m[3]!;
    const hash = m[4];

    if (kind === 'start') {
      open.set(name, { mode, ...(hash !== undefined ? { hash } : {}), startLine: i });
      continue;
    }

    const started = open.get(name);
    if (started === undefined) continue;
    open.delete(name);
    regions.push({
      name,
      mode: started.mode,
      ...(started.hash !== undefined ? { hash: started.hash } : {}),
      startLine: started.startLine,
      endLine: i,
      content: lines.slice(started.startLine + 1, i).join('\n'),
    });
  }

  return regions;
}
