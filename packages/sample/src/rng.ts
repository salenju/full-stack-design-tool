/**
 * 确定性伪随机数生成器（PRNG）。
 *
 * 为什么不用 Math.random：示例数据要能被「黄金样例测试」比对，要能进 git 做 code review，
 * 还要在两次生成之间保持一致（否则 `fsdt gen --check` 永远报漂移）。所以必须是
 * 「同一 seed → 同一序列」。
 *
 * 算法选 mulberry32：32 位状态、无依赖、分布够用（造测试数据不需要密码学强度），
 * 比 LCG 分布好，比 xorshift 少两行。
 */

export type Rng = {
  /** [0, 1) 均匀分布 */
  next(): number;
  /** [min, max] 闭区间整数 */
  int(min: number, max: number): number;
  /** 数组随机取一个；空数组返回 undefined */
  pick<T>(items: readonly T[]): T | undefined;
  /** 按权重取一个 */
  pickWeighted<T>(items: readonly { value: T; weight: number }[]): T | undefined;
  /** 概率为 p 时返回 true */
  chance(p: number): boolean;
  /** 洗牌（返回新数组，不改入参） */
  shuffle<T>(items: readonly T[]): T[];
};

/**
 * 32 位字符串散列（FNV-1a 变体）。
 * 用于把「seed + 表 + 行 + 字段」这类复合标识压成一个 uint32 种子，
 * 好处是**每个单元格独立随机**：给表加一个字段不会让其他字段的值全变。
 */
export function hashSeed(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function createRng(seed: number | string): Rng {
  let state = typeof seed === 'string' ? hashSeed(seed) : seed >>> 0;
  // 状态为 0 时 mulberry32 会退化成常量序列，兜一个非零值
  if (state === 0) state = 0x9e3779b9;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const int = (min: number, max: number): number => {
    if (max < min) return min;
    return min + Math.floor(next() * (max - min + 1));
  };

  const pick = <T>(items: readonly T[]): T | undefined => {
    if (items.length === 0) return undefined;
    return items[int(0, items.length - 1)];
  };

  const pickWeighted = <T>(items: readonly { value: T; weight: number }[]): T | undefined => {
    const total = items.reduce((sum, it) => sum + Math.max(0, it.weight), 0);
    if (total <= 0) return items[0]?.value;
    let r = next() * total;
    for (const it of items) {
      const w = Math.max(0, it.weight);
      if (r < w) return it.value;
      r -= w;
    }
    return items[items.length - 1]?.value;
  };

  const chance = (p: number): boolean => next() < p;

  const shuffle = <T>(items: readonly T[]): T[] => {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = int(0, i);
      const a = out[i]!;
      out[i] = out[j]!;
      out[j] = a;
    }
    return out;
  };

  return { next, int, pick, pickWeighted, chance, shuffle };
}
