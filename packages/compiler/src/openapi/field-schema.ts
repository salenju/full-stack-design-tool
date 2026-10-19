/**
 * Field → JSON Schema。
 *
 * 这是整个编译管线里被调用次数最多的函数，所以把三条容易踩的规则集中写在这里：
 *
 * 1. **required 不在字段上，在父对象的 `required: string[]` 里。** JSON Schema 的 required
 *    是「父级声明哪些属性必须存在」，字段自己写 required 是无效的。所以本文件只产出
 *    字段自己的 schema，`required` 由调用方（对象 / 请求体 / 参数列表）收集。
 *
 * 2. **`ref` 用 `$ref` 而不是内联。** 内联会让表结构在文档里出现 N 份副本，改一处要改 N 处，
 *    且 hey-api 生成出来是 N 个不兼容的匿名类型。用 `$ref` 指向 `components.schemas` 才能
 *    得到可复用的命名类型。
 *
 * 3. **`example` 只在字段显式给了才写。** 造数发生在编译之后（需要 seed 与引用完整性），
 *    这里凭空造一个会和 `seed.json` 对不上，比没有 example 更糟——用户会以为它们是同一份数据。
 */

import type { EnumDef, Field, FieldType } from '@fsdt/core-ir';
import { toPascalCase } from '@fsdt/core-ir';

import { schemaRef, type SchemaObject, type SchemaOrRef } from './types.js';

/** 名字冲突登记表：同一 schema 名被不同结构占用时，后到者加数字后缀 */
export type NameRegistry = Map<string, string>;

export interface FieldToSchemaOptions {
  /** 表节点 ID → schema 名，用于解析 `ref` 类型 */
  tableSchemaName: (tableId: string) => string | undefined;
  /** 枚举 ID → 枚举名，用于解析 `enumRef` */
  enumByName: Map<string, EnumDef>;
  /** 字段 ID → 已分配的 schema 名（仅 `ref` 以外的复杂类型需要） */
  nameRegistry?: NameRegistry;
  /** 是否为响应侧（响应侧不写 writeOnly，请求侧不写 readOnly） */
  side?: 'request' | 'response' | 'entity';
}

const STRING_FORMATS: Partial<Record<FieldType, string>> = {
  date: 'date',
  datetime: 'date-time',
};

/**
 * 把 IR 字段类型映射成 JSON Schema 的 type。
 * 注意 `enum` / `ref` / `object` / `array` 需要额外处理，不在这里给出 type。
 */
function baseTypeOf(type: FieldType): SchemaObject['type'] {
  switch (type) {
    case 'string':
    case 'text':
    case 'file':
    case 'date':
    case 'datetime':
      return 'string';
    case 'number':
      return 'number';
    case 'integer':
      return 'integer';
    case 'boolean':
      return 'boolean';
    case 'json':
      return undefined;
    default:
      return undefined;
  }
}

/**
 * 单个字段 → schema。返回的 schema 不含 `required`（见文件头说明）。
 */
export function fieldToSchema(field: Field, options: FieldToSchemaOptions): SchemaOrRef {
  const side = options.side ?? 'entity';

  // ── ref：优先用 $ref 复用目标表的 schema ──
  if (field.type === 'ref') {
    const ref = field.constraints?.ref;
    if (ref === undefined) {
      // 没有目标的 ref 无法解析成 $ref；退化成 string 并保留扩展标记，
      // 让 Lint（IR004）去报「外键目标缺失」，而不是让编译器崩掉。
      return withFieldMetadata({ type: 'string' }, field, side);
    }
    const target = options.tableSchemaName(ref.tableId);
    if (target === undefined) {
      // 目标表不在当前编译范围内（例如只编译了部分画布）：同样退化为 string。
      return withFieldMetadata({ type: 'string' }, field, side);
    }
    // 外键在 JSON 里就是目标表的主键值；用 $ref 指向整表会生成错误类型，
    // 所以这里取目标表的主键类型（string），并标注 x-dsg-fk 供生成器写关系。
    return withFieldMetadata(
      { type: 'string', ...(ref.fieldId !== undefined ? { 'x-dsg-fk-field': ref.fieldId } : {}) },
      field,
      side,
    );
  }

  // ── enum：展开取值，不再引用 $ref ──
  if (field.type === 'enum') {
    return withFieldMetadata(enumToSchema(field, options), field, side);
  }

  // ── array：元素类型递归 ──
  if (field.type === 'array') {
    const itemType = field.constraints?.arrayItem ?? 'string';
    const items: SchemaOrRef =
      itemType === 'ref'
        ? (() => {
            const target = field.constraints?.ref ? options.tableSchemaName(field.constraints.ref.tableId) : undefined;
            return target !== undefined ? schemaRef(target) : ({ type: 'string' } as SchemaObject);
          })()
        : fieldToSchema({ ...field, type: itemType, constraints: undefined }, options);
    return withFieldMetadata({ type: 'array', items }, field, side);
  }

  // ── object / json：不给结构，交给 additionalProperties ──
  if (field.type === 'object') {
    return withFieldMetadata({ type: 'object', additionalProperties: true }, field, side);
  }
  if (field.type === 'json') {
    // JSON 值可以是任意类型；OpenAPI 3.1 里留空 schema 即「任意」。
    // 但留空会让 hey-api 生成 unknown，这里显式写 {} 并加描述，语义更清楚。
    return withFieldMetadata({}, field, side);
  }

  const schema: SchemaObject = {};
  const type = baseTypeOf(field.type);
  if (type !== undefined) schema.type = type;

  const format = STRING_FORMATS[field.type];
  if (format !== undefined) schema.format = format;

  applyConstraints(schema, field);

  return withFieldMetadata(schema, field, side);
}

/** enum 字段 → 带 enum[] 的 schema。命名枚举与内联枚举都要支持。 */
function enumToSchema(field: Field, options: FieldToSchemaOptions): SchemaObject {
  const enumRef = field.constraints?.enumRef;
  const inline = field.constraints?.enumValues;

  if (enumRef !== undefined) {
    const def = options.enumByName.get(enumRef);
    if (def !== undefined) {
      return { type: 'string', enum: def.values.map((v) => v.value) };
    }
    // 引用了不存在的枚举：Lint IR003 会报，这里退化为 string 不阻断编译
    return { type: 'string' };
  }
  if (inline !== undefined && inline.length > 0) {
    return { type: 'string', enum: [...inline] };
  }
  return { type: 'string' };
}

/** 把 constraints 映射到 JSON Schema 关键字 */
function applyConstraints(schema: SchemaObject, field: Field): void {
  const c = field.constraints;
  if (c === undefined) return;

  if (c.minLength !== undefined) schema.minLength = c.minLength;
  if (c.maxLength !== undefined) schema.maxLength = c.maxLength;
  if (c.minimum !== undefined) schema.minimum = c.minimum;
  if (c.maximum !== undefined) schema.maximum = c.maximum;
  if (c.pattern !== undefined) schema.pattern = c.pattern;
  if (c.default !== undefined) schema.default = c.default;

  // integer 的 precision/scale 无意义；number 才写
  if (field.type === 'number') {
    if (c.precision !== undefined) schema['x-dsg-precision'] = c.precision;
    if (c.scale !== undefined) schema['x-dsg-scale'] = c.scale;
  }
}

/**
 * 附加描述、示例与 x-dsg-* 扩展。
 *
 * 注意 `example` 一律写 JSON Schema 的 `example`（3.1 允许），**不**写 OpenAPI 的
 * `example` 字段——后者只在 parameter / media type 层有效，写在 schema 里会被校验器忽略。
 */
function withFieldMetadata(schema: SchemaObject, field: Field, side: 'request' | 'response' | 'entity'): SchemaObject {
  const out: SchemaObject = { ...schema };

  const description = field.description ?? field.comment;
  if (description !== undefined && description.length > 0) out.description = description;

  if (field.example !== undefined) out.example = field.example;

  // 只读 / 只写的语义方向：请求里不应该出现 readOnly 字段，响应里不应该出现 writeOnly。
  // 用 OpenAPI 标准的 readOnly / writeOnly 关键字（3.1 有），让生成器自己过滤。
  if (side !== 'response' && field.readOnly === true) out.readOnly = true;
  if (side !== 'request' && field.writeOnly === true) out.writeOnly = true;

  if (field.sensitive === true) out['x-dsg-sensitive'] = true;
  if (field.deprecated === true) out.deprecated = true;

  return out;
}

/**
 * 一组字段 → object schema，并收集 `required`。
 *
 * `readOnlyFields` 参数用于「创建 DTO」场景：主键与 createdAt 这类字段在创建请求里
 * 不应出现，而不是「可选」。两者的区别在生成出来的 TS 类型上是 `id?: string` 与
 * 完全没有 `id` —— 后者才是对的。
 */
export function fieldsToObjectSchema(
  fields: Field[],
  options: FieldToSchemaOptions & { exclude?: ReadonlySet<string>; include?: ReadonlySet<string> } = {
    tableSchemaName: () => undefined,
    enumByName: new Map(),
  },
): SchemaObject {
  const properties: Record<string, SchemaOrRef> = {};
  const required: string[] = [];

  for (const field of fields) {
    if (options.exclude?.has(field.id) === true) continue;
    if (options.include !== undefined && !options.include.has(field.id)) continue;
    properties[field.name] = fieldToSchema(field, options);
    if (field.required) required.push(field.name);
  }

  const schema: SchemaObject = { type: 'object', properties };
  if (required.length > 0) schema.required = required;
  return schema;
}

/** 生成一个稳定的 schema 名（PascalCase + 冲突消解） */
export function allocateSchemaName(base: string, registry: NameRegistry): string {
  const normalized = toPascalCase(base) || 'Anonymous';
  const existing = registry.get(normalized);
  if (existing === undefined) {
    registry.set(normalized, normalized);
    return normalized;
  }
  let i = 2;
  while (registry.has(`${normalized}${i}`)) i += 1;
  const name = `${normalized}${i}`;
  registry.set(name, name);
  return name;
}
