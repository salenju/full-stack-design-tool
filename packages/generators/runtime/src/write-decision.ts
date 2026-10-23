/**
 * 「这个文件该不该写、写成什么」的决策。
 *
 * 从 CLI 的 `gen` 里提取出来，是因为服务模式的生成端点要做**一模一样**的判断：
 * 同一份 IR、同一套产物，命令行和 HTTP 的结果必须相同，否则「本地生成的」和
 * 「工作台生成的」会分叉，而用户根本看不出是哪边错了。
 *
 * 纯函数、不做 IO：读盘由调用方做，写盘也由调用方做。这样才能对着任意
 * (磁盘内容, 基线, 新内容) 三元组写单测。
 */

import { hashContent } from '@fsdt/core-ir';

import type { ManifestFile } from './manifest.js';
import { mergeRegions, regionsOf } from './merge.js';
import type { RenderedFile } from './types.js';

export type WriteAction =
  /** 全量覆盖（首次生成、`--force`、或文件没被改过） */
  | 'write'
  /** 区块级合并后写入：骨架更新了，手写区块保留 */
  | 'merged'
  /** 与磁盘逐字节相同，无需写 */
  | 'unchanged'
  /** 合不动，保留磁盘内容并报告冲突 */
  | 'conflict';

export interface WriteDecision {
  action: WriteAction;
  content: string;
  /** 冲突原因（人话），非冲突时为空 */
  reasons: string[];
}

/**
 * manifest 条目。
 *
 * 必须记**纯净生成内容**的哈希（`file.content`），不能是合并后的磁盘内容：
 * 合并结果里含用户手写部分，一旦记成基线，下次生成就会认为「没人改过」，
 * 直接覆盖——todo 区块里的实现当场丢失。
 */
export function manifestEntryOf(file: RenderedFile, manifestPath: string): ManifestFile {
  const parsed = regionsOf(file.content);
  return {
    path: manifestPath,
    hash: hashContent(file.content),
    kind: file.kind,
    sourceNodeIds: file.sourceNodeIds,
    overwrite: file.overwrite,
    regions:
      parsed.length > 0
        ? parsed
        : file.regions.map((r) => ({ name: r.name, mode: r.mode, hash: r.hash })),
  };
}

/**
 * 决定一个已存在的文件该怎么处理。
 *
 * 优先级：内容相同 → 跳过；`force` → 覆盖；`never` → 不碰；
 * 没被改过 → 覆盖；被改过 → 尝试区块合并，合不动才报冲突。
 */
export function decideWrite(
  file: RenderedFile,
  existing: string,
  previous: ManifestFile | undefined,
  force: boolean,
): WriteDecision {
  if (existing === file.content) return { action: 'unchanged', content: existing, reasons: [] };
  if (force) return { action: 'write', content: file.content, reasons: [] };
  if (file.overwrite === 'never') {
    return { action: 'conflict', content: existing, reasons: ['文件标记为不可覆盖（只在不存在时写入）'] };
  }

  const handEdited = previous !== undefined && hashContent(existing) !== previous.hash;
  if (file.overwrite === 'always' || !handEdited) {
    return { action: 'write', content: file.content, reasons: [] };
  }

  const merged = mergeRegions(file.content, existing, previous?.regions ?? []);
  if (merged.status === 'merged') return { action: 'merged', content: merged.content, reasons: [] };
  if (merged.status === 'unchanged') return { action: 'unchanged', content: existing, reasons: [] };
  if (merged.status === 'unmergeable') {
    return {
      action: 'conflict',
      content: existing,
      reasons: ['文件里没有 @dsg 区块标记，无法判断哪些是手写内容'],
    };
  }
  return { action: 'conflict', content: existing, reasons: merged.conflicts.map(describeConflict) };
}

export function describeConflict(conflict: { region: string; reason: string }): string {
  if (conflict.reason === 'removed-region') return `区块 ${conflict.region}：磁盘上有，但本次生成不再产出`;
  return `区块 ${conflict.region}：生成的内容被手工改过，无法自动抉择`;
}
