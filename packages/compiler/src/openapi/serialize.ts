/**
 * OpenAPI 文档 → 文本。
 *
 * 为什么不用 `JSON.stringify` / `YAML.stringify` 直接输出：
 * 产物要进 git，会出现在 code review 的 diff 里。默认序列化会带来两类噪音：
 * - YAML 会按行宽折行，导致改一个字段名在 diff 里表现为三行变化；
 * - 空对象 / 空数组被写成 `{}` / `[]` 一行，而 `properties: {}` 与「没有 properties」
 *   在阅读时很难区分。
 *
 * 所以这里做两件事：关掉折行；把「空容器」保留成显式形式（`{}`），而不是省略。
 */

import YAML from 'yaml';

import type { OpenApiDocument } from './types.js';

export interface SerializeOptions {
  /** 'yaml'（默认，给人读与 git diff）或 'json'（给只吃 JSON 的工具链） */
  format?: 'yaml' | 'json';
  /** JSON 缩进，默认 2 */
  indent?: number;
}

export function serializeOpenApi(doc: OpenApiDocument, options: SerializeOptions = {}): string {
  const format = options.format ?? 'yaml';

  if (format === 'json') {
    return `${JSON.stringify(doc, null, options.indent ?? 2)}\n`;
  }

  // lineWidth: 0 关闭折行；aliasDuplicateObjects: false 避免 YAML 把重复出现的
  // 相同对象写成锚点/引用（`&ref_0` / `*ref_0`）——那对读者与 diff 都是灾难。
  return YAML.stringify(doc, {
    lineWidth: 0,
    aliasDuplicateObjects: false,
    sortMapEntries: false,
  });
}
