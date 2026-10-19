/**
 * 代码文本 writer。
 *
 * 为什么不用 Eta / Handlebars 这类模板引擎：
 * 1. **确定性。** 生成结果要能进 git、能算哈希、能 `--check` 比对漂移。模板引擎的
 *    空白处理（trim、换行折叠）跨版本会变，一旦变了所有黄金样例全红，而原因不可见。
 * 2. **缩进要能算。** Vue/NestJS 的产物是三层嵌套（模板 / script / 对象字面量），
 *    手写作图式 API 能在任意位置精确控制缩进，模板里只能靠人肉对齐空格。
 * 3. **空行是语义。** 生成代码要给人改，块之间该有一个空行。writer 把「写空行」
 *    变成显式操作，`blank()` 重复调用会自动折叠，避免出现两三个连续空行。
 */

export interface WriterOptions {
  /** 缩进字符串，默认两个空格（前端与后端统一，不用 tab） */
  indentUnit?: string;
}

export class Writer {
  private readonly lines: string[] = [];
  private depth = 0;
  private readonly unit: string;

  constructor(options: WriterOptions = {}) {
    this.unit = options.indentUnit ?? '  ';
  }

  /** 写一行（自动加当前缩进） */
  line(text = ''): this {
    if (text === '') {
      this.lines.push('');
      return this;
    }
    this.lines.push(this.unit.repeat(this.depth) + text);
    return this;
  }

  /** 写多行：按 \n 拆开逐行写，用于把多行片段原样插入 */
  lines_(text: string): this {
    for (const l of text.split('\n')) this.line(l);
    return this;
  }

  /** 空行；连续调用只保留一个 */
  blank(): this {
    if (this.lines.length === 0) return this;
    if (this.lines[this.lines.length - 1] === '') return this;
    this.lines.push('');
    return this;
  }

  /** 增加缩进 */
  indent(): this {
    this.depth += 1;
    return this;
  }

  /** 减少缩进（不会低于 0） */
  dedent(): this {
    if (this.depth > 0) this.depth -= 1;
    return this;
  }

  /** 在缩进内执行一段 */
  block(fn: (w: Writer) => void): this {
    this.depth += 1;
    fn(this);
    this.depth -= 1;
    return this;
  }

  /** 渲染为字符串：去掉末尾多余空行，保证以单个 \n 结尾 */
  toString(): string {
    const out = [...this.lines];
    while (out.length > 0 && out[out.length - 1] === '') out.pop();
    return out.join('\n') + '\n';
  }

  /** 当前行数（写 region 标记时用） */
  get lineCount(): number {
    return this.lines.length;
  }
}

/** 常量大写：'deviceName' → 'DEVICE_NAME' */
export function toConstantCase(input: string): string {
  return input
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .toUpperCase();
}

/**
 * 字符串字面量的安全引号化。
 *
 * 直接用 `'${s}'` 会在字段名含单引号或反斜杠时生成语法错误的代码——这类错误
 * 出现在生成产物里最难排查，因为源文件（IR）看起来完全正常。
 */
export function quote(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  return `'${escaped}'`;
}

/** 把任意字符串当成安全的单行注释内容（去掉换行，避免注释吃掉下一行代码） */
export function commentSafe(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

/**
 * 对齐的对象字面量输出。
 *
 * 手写 `JSON.stringify(obj, null, 2)` 的问题是它会把 `undefined` 丢掉、
 * 把嵌套数组展开成多行、还会给数字加不必要的格式——生成的 TS 代码里
 * 这些都不是我们想要的。
 */
export function objectLiteral(
  entries: Array<[string, string]>,
  options: { indent?: number; multiline?: boolean } = {},
): string {
  if (entries.length === 0) return '{}';
  const multiline = options.multiline ?? entries.length > 2;
  if (!multiline) {
    return `{ ${entries.map(([k, v]) => `${k}: ${v}`).join(', ')} }`;
  }
  const pad = ' '.repeat(options.indent ?? 2);
  const body = entries.map(([k, v]) => `${pad}${k}: ${v},`).join('\n');
  return `{\n${body}\n}`;
}

/** 数组字面量；空数组写 `[]` 而不是展开的多行空括号 */
export function arrayLiteral(items: string[], options: { indent?: number; multiline?: boolean } = {}): string {
  if (items.length === 0) return '[]';
  const multiline = options.multiline ?? items.length > 3;
  if (!multiline) return `[${items.join(', ')}]`;
  const pad = ' '.repeat(options.indent ?? 2);
  return `[\n${items.map((i) => `${pad}${i},`).join('\n')}\n]`;
}
