/**
 * 命名策略：把 IR 里的名字转换成各目标语言/文件的写法。
 *
 * 为什么集中在这里：命名规则散落在生成器模板里，是「同一字段在 DTO 叫 deviceId、
 * 在 Prisma 叫 device_id、在路由叫 device-id」这类不一致的根源。
 * 所有转换必须经过本模块，且被单测覆盖。
 */

import type { NamingSettings } from './types.js';

/** 拆分标识符为词元：支持 camelCase / PascalCase / snake_case / kebab-case / 空格 */
export function splitWords(input: string): string[] {
  if (input.length === 0) return [];
  return (
    input
      // 先按分隔符切
      .split(/[\s_\-.]+/)
      // 再按大小写边界切：aB → a|B，ABCd → ABC|d
      .flatMap((part) => part.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/))
      .filter((w) => w.length > 0)
  );
}

function cap(word: string): string {
  if (word.length === 0) return word;
  // 全大写缩写（如 ID、URL）保留原样，避免 Id → ID 反复变化
  if (word.length <= 3 && word === word.toUpperCase() && /^[A-Z]+$/.test(word)) {
    return word.charAt(0) + word.slice(1).toLowerCase();
  }
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

export function toCamelCase(input: string): string {
  const words = splitWords(input);
  if (words.length === 0) return '';
  const [first, ...rest] = words as [string, ...string[]];
  return first.toLowerCase() + rest.map(cap).join('');
}

export function toPascalCase(input: string): string {
  return splitWords(input).map(cap).join('');
}

export function toSnakeCase(input: string): string {
  return splitWords(input)
    .map((w) => w.toLowerCase())
    .join('_');
}

export function toKebabCase(input: string): string {
  return splitWords(input)
    .map((w) => w.toLowerCase())
    .join('-');
}

/** 常量风格：DEVICE_STATUS */
export function toConstantCase(input: string): string {
  return splitWords(input)
    .map((w) => w.toUpperCase())
    .join('_');
}

/** 复数化（仅用于 REST 路由与表名；英文不规则复数只覆盖常见几个） */
const IRREGULAR_PLURALS: Record<string, string> = {
  person: 'people',
  child: 'children',
  man: 'men',
  woman: 'women',
  mouse: 'mice',
  foot: 'feet',
  tooth: 'teeth',
  datum: 'data',
  medium: 'media',
  index: 'indexes',
  status: 'statuses',
  device: 'devices',
};

export function pluralize(word: string): string {
  const lower = word.toLowerCase();
  const irregular = IRREGULAR_PLURALS[lower];
  if (irregular !== undefined) return irregular;

  if (/(s|x|z|ch|sh)$/.test(lower)) return lower + 'es';
  if (/[^aeiou]y$/.test(lower)) return lower.slice(0, -1) + 'ies';
  if (/f$/.test(lower)) return lower.slice(0, -1) + 'ves';
  if (/fe$/.test(lower)) return lower.slice(0, -2) + 'ves';
  return lower + 's';
}

export function singularize(word: string): string {
  const lower = word.toLowerCase();
  const irregular = Object.entries(IRREGULAR_PLURALS).find(([, plural]) => plural === lower);
  if (irregular !== undefined) return irregular[0];

  if (/ies$/.test(lower)) return lower.slice(0, -3) + 'y';
  if (/(ses|xes|zes|ches|shes)$/.test(lower)) return lower.slice(0, -2);
  if (/ves$/.test(lower)) return lower.slice(0, -3) + 'f';
  if (/s$/.test(lower) && !/ss$/.test(lower)) return lower.slice(0, -1);
  return lower;
}

/** 表名 → 接口路径段（kebab 复数），如 DeviceLog → device-logs */
export function tableToPathSegment(name: string, settings: NamingSettings): string {
  const base = settings.pathCase === 'snake' ? toSnakeCase(name) : toKebabCase(name);
  return pluralize(base);
}

/**
 * 表名 → Prisma model 名（Pascal 单数）。
 * 必须**先拆词再对最后一个词做单数化**：直接 singularize(DeviceLogs) 会把整串小写成
 * devicelog，丢掉词边界。
 */
export function tableToModelName(name: string): string {
  const words = splitWords(name);
  if (words.length === 0) return '';
  const last = words[words.length - 1] as string;
  const head = words.slice(0, -1);
  return [...head, singularize(last)].map(cap).join('');
}

/** 接口路径 → operationId 兜底：GET /devices/{id} → getDevicesById */
export function pathToOperationId(method: string, path: string): string {
  const segments = path
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => {
      const m = /^\{(.+)\}$/.exec(s);
      return m !== null ? `by-${m[1]}` : s;
    });
  const tail = segments.map((s) => toPascalCase(s)).join('');
  return toCamelCase(method.toLowerCase() + '-' + tail);
}

/** 字段名按设置输出物理列名 */
export function fieldToDbName(name: string, settings: NamingSettings): string {
  return settings.fieldCase === 'snake' ? toSnakeCase(name) : toCamelCase(name);
}

/** 字段名按设置输出 API 名 */
export function fieldToApiName(name: string, settings: NamingSettings): string {
  return settings.fieldCase === 'camel' ? toCamelCase(name) : toSnakeCase(name);
}

/** 文件名（按 fileCase） */
export function toFileName(name: string, settings: NamingSettings, ext?: string): string {
  const base = settings.fileCase === 'pascal' ? toPascalCase(name) : toKebabCase(name);
  return ext === undefined ? base : `${base}.${ext}`;
}

/** 校验是否是合法 JS 标识符 */
export function isIdentifier(value: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value);
}

/** 保留字集合（避免生成 `class`、`default` 这类字段名） */
export const RESERVED_WORDS = new Set([
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'import',
  'in',
  'instanceof',
  'new',
  'null',
  'return',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'yield',
  'let',
  'static',
  'await',
  'implements',
  'interface',
  'package',
  'private',
  'protected',
  'public',
]);

/**
 * 转成合法的 npm 包名。
 *
 * 为什么需要它：`project.name` 是中文（「设备管理」）时，直接拿去做
 * `package.json` 的 `name` 会生成一个**装不上的项目**——npm 包名只允许
 * 小写 ASCII、数字、`. _ -`，且不能为空。用户 `pnpm install` 时会看到
 * 一条与设计稿毫无关系的报错，根本想不到是项目名引起的。
 *
 * 刻意**不转拼音**（与字段名策略一致）：`设备管理 → shebeiguanli` 是反模式。
 * 剥不出 ASCII 时用调用方给的 fallback（如 `fsdt-frontend`），
 * 并在生成物里保留中文 title，读起来仍然是人话。
 */
export function toPackageName(input: string, fallback = 'fsdt-app'): string {
  // fallback 传空串表示「剥不出来就返回空」，供调用方自己拼后缀。
  // 后端生成器需要这种用法：它要产 `${项目名}-backend`，而中文项目名剥完
  // 只剩 `-backend`，直接被当成包名 'backend'——所有项目都叫 backend，
  // 装进同一个 node_modules 会互相覆盖。
  const slug = input
    .toLowerCase()
    // 下划线与点虽然 npm 允许，但与连字符混用会让同一个项目在不同地方
    // 写出三种名字（my_tool / my.tool / my-tool），统一成连字符
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length === 0 || !/[a-z0-9]/.test(slug)) return fallback;
  // npm 名字上限 214 字符；这里取更保守的 60，避免路径过长
  return slug.length > 60 ? slug.slice(0, 60).replace(/-+$/, '') : slug;
}

/** 把可能撞保留字的名字安全化：class → class_ */
export function safeIdentifier(value: string): string {
  return RESERVED_WORDS.has(value) ? `${value}_` : value;
}
