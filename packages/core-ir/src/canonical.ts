/**
 * 规范化序列化（canonical JSON）。
 *
 * 用途：为 IR 计算 `schemaHash`——**必须与键顺序、空白、依赖版本无关**，
 * 否则「同一份 IR」在不同机器上算出不同哈希，漂移门禁（`fsdt gen --check`）会天天误报。
 *
 * 规则：
 * 1. 对象键按字典序排序（仅在「哈希用途」下开启，输出给人看时保持原序）。
 * 2. 省略 `undefined`（JSON 本身也会丢，但 JSON.stringify 在数组里会变成 null，这里统一按 null）。
 * 3. 数字用最短往返表示（Number.prototype.toString 已是该语义）。
 * 4. 不排序数组——数组顺序是语义的一部分（字段顺序、连线顺序）。
 */

export type CanonicalOptions = {
  /** 排序对象键；默认 true。给人看的导出用 false */
  sortKeys?: boolean;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function canonicalize(value: unknown, options: CanonicalOptions = {}): string {
  const sortKeys = options.sortKeys ?? true;

  const walk = (v: unknown): string => {
    if (v === null) return 'null';
    if (v === undefined) return 'null';

    const t = typeof v;
    if (t === 'number') {
      const n = v as number;
      if (!Number.isFinite(n)) return 'null';
      // -0 与 0 视为同一值，否则哈希会因符号位抖动
      return Object.is(n, -0) ? '0' : String(n);
    }
    if (t === 'boolean') return v === true ? 'true' : 'false';
    if (t === 'string') return JSON.stringify(v);
    if (t === 'bigint') return JSON.stringify((v as bigint).toString());
    if (t === 'function' || t === 'symbol') return 'null';

    if (Array.isArray(v)) {
      return `[${v.map(walk).join(',')}]`;
    }
    if (isPlainObject(v)) {
      const keys = Object.keys(v);
      if (sortKeys) keys.sort();
      const parts: string[] = [];
      for (const k of keys) {
        const val = (v as Record<string, unknown>)[k];
        if (val === undefined) continue;
        parts.push(`${JSON.stringify(k)}:${walk(val)}`);
      }
      return `{${parts.join(',')}}`;
    }
    // Date / Map / Set 等：转成标准化字符串，而不是依赖隐式 toString
    if (v instanceof Date) return JSON.stringify(v.toISOString());
    return JSON.stringify(String(v));
  };

  return walk(value);
}

/**
 * 不可变数据的稳定字符串化，用于快照比较与测试断言。
 * 与 canonicalize 的区别：保留键序（便于人读 diff），但同样省略 undefined。
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (v === undefined ? undefined : v), 2);
}
