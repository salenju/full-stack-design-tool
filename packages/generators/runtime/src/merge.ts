/**
 * 区块级三方合并。
 *
 * 这是往返机制的执行端：`markers.ts` 只负责「写出标记、读懂标记」，这里负责
 * 「重新生成时，磁盘上那份被改过的文件该怎么处理」。
 *
 * ## 三方是哪三方
 *
 * | 方 | 来源 | 作用 |
 * |---|---|---|
 * | base | manifest 里上次生成的区块哈希 | 判断「用户有没有动过这个 generated 区块」 |
 * | ours（disk） | 磁盘上的当前文件 | 用户手写内容、已实现的 todo 区块都在这里 |
 * | theirs（next） | 本次生成的内容 | 契约变化后的新骨架 |
 *
 * ## 合并规则（按区块，不按行）
 *
 * - `todo` / `handwritten` 区块 → **一律保留磁盘内容**。todo 是「等着人来填」的
 *   容器，填完就该留住；重新生成时清空它等于把用户工作删掉。
 * - `generated` 区块 → 磁盘内容哈希与 base 一致（没动过）就换成新内容；
 *   不一致（用户改过）则算冲突，保留磁盘内容并回报，由用户决定怎么写。
 * - 磁盘上多出来的区块（生成器本次不再产出）→ 冲突。不猜它该挪到哪，
 *   挪错位置的代码比丢代码更难查。
 *
 * ## 为什么不按行做 diff3
 *
 * 生成代码的区块内部是「整块重写」的（例如整个 columns 数组），行级 diff3 会把
 * 一次契约改名劈成几十个碎冲突，用户得逐个点。区块级合并的粒度刚好等于
 * 「这段是生成器的 / 这段是你的」。
 *
 * ## 安全前提
 *
 * 磁盘上**没有任何标记**的文件一律不合并（返回 `unmergeable`）。用户可能整个
 * 文件重写过，此时任何自动合并都是在猜。宁可报冲突让 `--force` 出场。
 */

import { hashRegion } from '@fsdt/core-ir';

import type { ManifestRegion } from './manifest.js';
import { parseRegions, type ParsedRegion } from './markers.js';

export type MergeConflictReason =
  /** generated 区块被用户改过，不知道谁的内容才是对的 */
  | 'edited-generated'
  /** 磁盘上有生成器本次不产出的区块 */
  | 'removed-region';

export interface MergeConflict {
  region: string;
  reason: MergeConflictReason;
}

export type MergeStatus =
  /** 合并完成，结果与磁盘不同，需要写盘 */
  | 'merged'
  /** 合并完成，结果与磁盘逐字节相同，无需写盘 */
  | 'unchanged'
  /** 有冲突，`content` 返回磁盘原文（调用方不应写盘） */
  | 'conflict'
  /** 两边缺少区块标记，无法合并 */
  | 'unmergeable';

export interface MergeResult {
  status: MergeStatus;
  /** 合并后的内容；status 为 conflict / unmergeable 时等于磁盘原文 */
  content: string;
  conflicts: MergeConflict[];
  /** 保留了磁盘内容的区块名（生成报告里用来说明「哪些没被覆盖」） */
  kept: string[];
}

interface Body {
  /** 保留哪个区块中的内容行（不含标记行） */
  source: 'disk' | 'next';
  region: ParsedRegion;
}

/**
 * 三方合并单个文件。
 *
 * 纯函数：同样三份输入永远得到同样输出，这样才能参与 `gen --check` 的判定。
 */
export function mergeRegions(next: string, disk: string, baseRegions: readonly ManifestRegion[]): MergeResult {
  const nextRegions = parseRegions(next);
  const diskRegions = parseRegions(disk);

  // 任何一边没有标记都不合并：没有容器的文件，用户可能整体重写过
  if (nextRegions.length === 0 || diskRegions.length === 0) {
    return { status: 'unmergeable', content: disk, conflicts: [], kept: [] };
  }

  const diskByName = new Map(diskRegions.map((r) => [r.name, r]));
  const nextNames = new Set(nextRegions.map((r) => r.name));
  const baseHash = new Map(baseRegions.map((r) => [r.name, r.hash]));

  const conflicts: MergeConflict[] = [];
  const kept: string[] = [];
  const bodies = new Map<string, Body>();

  for (const region of diskRegions) {
    if (!nextNames.has(region.name)) conflicts.push({ region: region.name, reason: 'removed-region' });
  }

  for (const region of nextRegions) {
    const onDisk = diskByName.get(region.name);
    if (onDisk === undefined) {
      // 磁盘上还没有这个区块（生成器新增），直接用生成内容
      bodies.set(region.name, { source: 'next', region });
      continue;
    }

    // todo / handwritten 区块：磁盘内容就是用户写的，无条件保留。
    // 也覆盖「用户把 generated 手工改成 handwritten」的情况——那是明确的表态。
    if (region.mode !== 'generated' || onDisk.mode !== 'generated') {
      bodies.set(region.name, { source: 'disk', region: onDisk });
      kept.push(region.name);
      continue;
    }

    const base = baseHash.get(region.name);
    if (base !== undefined && hashRegion(onDisk.content) === base) {
      bodies.set(region.name, { source: 'next', region });
      continue;
    }

    conflicts.push({ region: region.name, reason: 'edited-generated' });
    bodies.set(region.name, { source: 'disk', region: onDisk });
    kept.push(region.name);
  }

  if (conflicts.length > 0) {
    return { status: 'conflict', content: disk, conflicts, kept };
  }

  const content = rebuild(next, disk, nextRegions, bodies);
  return { status: content === disk ? 'unchanged' : 'merged', content, conflicts, kept };
}

/**
 * 用合并结果重建文件。
 *
 * 区块外的文本（imports、签名、模板）一律以本次生成为准——它们由 IR 决定。
 * 这是刻意的：`DO_NOT_EDIT_NOTICE` 写明了手写内容要放进 `@dsg:handwritten` 区块，
 * 区块外的东西下次重新生成本来就该被覆盖。反过来「区块外也做 diff」会让每次契约
 * 改动都变成冲突，用户只能天天 `--force`，合并等于不存在。
 */
function rebuild(next: string, disk: string, regions: ParsedRegion[], bodies: Map<string, Body>): string {
  const nextLines = next.split('\n');
  const diskLines = disk.split('\n');
  const out: string[] = [];
  let cursor = 0;

  for (const region of regions) {
    for (let i = cursor; i < region.startLine; i += 1) out.push(nextLines[i]!);

    const body = bodies.get(region.name)!;
    if (body.source === 'next') {
      // 生成侧原文照搬：标记行与内容里都已经带好哈希
      for (let i = region.startLine; i <= region.endLine; i += 1) out.push(nextLines[i]!);
    } else {
      // 磁盘侧：标记行连内容一起原样保留。
      //
      // 特意**不**刷新标记行的哈希：这里只换回区块内容，文件其实没变化。若顺手
      // 把 hash= 改成磁盘内容的哈希，合并结果就与磁盘不再逐字节相同，
      // `gen --check` 会把它报成漂移——CI 从此每次红灯，而用户什么都没改。
      // 哈希的意义是「上次生成时这段长什么样」，它归 manifest 管（manifest 里
      // 存的是纯净生成内容的哈希），文件里的 hash 只是给人看的快照。
      for (let i = body.region.startLine; i <= body.region.endLine; i += 1) out.push(diskLines[i]!);
    }

    cursor = region.endLine + 1;
  }

  for (let i = cursor; i < nextLines.length; i += 1) out.push(nextLines[i]!);
  return out.join('\n');
}

/**
 * 从生成内容里读出区块清单，写进 manifest 作为下次合并的基线。
 *
 * 基线必须是**纯净生成内容**（不是合并后的磁盘内容）：否则「手写过一次」的文件
 * 会被记成「没改过」，下一次生成直接覆盖，todo 区块里的实现就没了。
 */
export function regionsOf(content: string): ManifestRegion[] {
  return parseRegions(content).map((r) => ({
    name: r.name,
    mode: r.mode,
    hash: r.hash ?? hashRegion(r.content),
  }));
}
