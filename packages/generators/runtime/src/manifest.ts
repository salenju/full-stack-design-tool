/**
 * manifest 与增量生成。
 *
 * manifest 的**首要用途不是增量，是漂移检测**：
 * - 记录了「上次生成时每个文件长什么样」→ 才能判断用户是否手改过（决定能不能覆盖）；
 * - 记录了「上次生成时的 IR 语义哈希」→ 才能判断「契约变了但文件没重生成」；
 * - `fsdt gen --check` 在 CI 里比对这两个哈希，把「改了画布忘了重新生成」拦在合并前。
 *
 * 增量生成是顺带的好处：只重渲染 `sourceNodeIds` 或其依赖字段变化的文件。
 */

import type { RegionMode } from './types.js';

export interface ManifestRegion {
  name: string;
  mode: RegionMode;
  hash: string;
}

export interface ManifestFile {
  path: string;
  /** 整个文件的 sha256，用于判断用户是否手改过 */
  hash: string;
  kind: string;
  sourceNodeIds: string[];
  overwrite: string;
  regions: ManifestRegion[];
}

export interface Manifest {
  /** manifest 格式版本，将来结构变化时用于迁移 */
  manifestVersion: 1;
  /** 本次生成 ID */
  generationId: string;
  /** 生成时的 IR 语义哈希（不含坐标/视口） */
  schemaHash: string;
  /** 文件头里写的那个哈希，与 schemaHash 同源，供文件级反查 */
  files: ManifestFile[];
  createdAt: string;
  generator: Record<string, string>;
  /** 生成过程中产生的告警，例如「字段解析不到，已跳过」 */
  warnings: string[];
  /**
   * 产物输出根目录（相对项目根，POSIX 分隔符）。
   *
   * 必须记录：`fsdt gen --out ./output` 会把文件写到 `output/` 下，而
   * `fsdt gen --check` 在 CI 里通常不带 `--out`。少了这个字段，--check 会去
   * 项目根找文件、全部报「文件缺失」——一个纯粹由「两次调用参数不同」引起的假红灯。
   * 缺省（undefined）表示项目根。
   */
  outputRoot?: string;
}

export interface ManifestDiff {
  /** 新增的文件 */
  added: string[];
  /** 内容变化的文件 */
  changed: string[];
  /** 本次不再产出的文件（不会自动删除，只提示） */
  removed: string[];
  /** 用户手改过、且内容会变的文件（需人工确认） */
  conflicted: string[];
}

/**
 * 对比新旧 manifest。
 *
 * `conflicted` 的判定：旧 manifest 里记录的文件哈希与磁盘实际哈希不同（用户改过），
 * 且新旧生成内容不同（覆盖就会丢用户改动）。这是「只提示不覆盖」的依据。
 */
export function diffManifest(
  previous: Manifest | undefined,
  next: Manifest,
  actualHashes: Map<string, string> = new Map(),
): ManifestDiff {
  const diff: ManifestDiff = { added: [], changed: [], removed: [], conflicted: [] };
  if (previous === undefined) {
    diff.added = next.files.map((f) => f.path);
    return diff;
  }

  const prevByPath = new Map(previous.files.map((f) => [f.path, f]));
  const nextByPath = new Map(next.files.map((f) => [f.path, f]));

  for (const file of next.files) {
    const prev = prevByPath.get(file.path);
    if (prev === undefined) {
      diff.added.push(file.path);
      continue;
    }
    if (prev.hash === file.hash) continue;

    const actual = actualHashes.get(file.path);
    const handEdited = actual !== undefined && actual !== prev.hash;
    if (handEdited) diff.conflicted.push(file.path);
    else diff.changed.push(file.path);
  }

  for (const path of prevByPath.keys()) {
    if (!nextByPath.has(path)) diff.removed.push(path);
  }

  diff.added.sort();
  diff.changed.sort();
  diff.removed.sort();
  diff.conflicted.sort();
  return diff;
}

/** 判断是否需要重新生成整个项目（无历史 → 全量） */
export function needsFullRegeneration(previous: Manifest | undefined): boolean {
  return previous === undefined || previous.manifestVersion !== 1;
}
