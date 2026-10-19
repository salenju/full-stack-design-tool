/**
 * IR → Prisma schema 生成。
 *
 * 为什么先写 Prisma 而不是 service：Prisma schema 是**唯一会被用户长期保留**的产物——
 * 迁移文件会长在这个文件之上，一旦模型名或字段映射错了，改回来的代价是重写迁移历史。
 * 所以这里的映射规则要显式、可读、可测，而不是「差不多就行」。
 *
 * 三条映射纪律：
 * 1. **物理名全部落到 `@@map` / `@map`**。Prisma 默认用模型名和字段名当物理名，
 *    而 IR 里 dbName 是权威的 snake_case；不显式映射的话，数据库里会出现
 *    `Device` 表和 `deviceName` 列，与既有库对不上。
 * 2. **外键关系两侧都要写**。Prisma 要求 relation 字段在两侧都存在，
 *    只写一边会让 `prisma validate` 直接报错；反向字段带 `[]` 表示一对多。
 * 3. **主键与时间戳按 IR 开关生成**，不无条件加 `id Int @id @default(autoincrement())`：
 *    用户可能用字符串主键或业务主键（如 deviceCode），塞一个自增 id 进去会污染契约。
 */

import {
  buildGraphIndex,
  getTable,
  sortedEnums,
  sortedTables,
  toCamelCase,
  toPascalCase,
  toSnakeCase,
  type EnumDef,
  type Field,
  type FieldType,
  type GraphIndex,
  type IR,
  type TableNode,
} from '@fsdt/core-ir';
import { Writer } from '@fsdt/generators-runtime';

/** Prisma 标量类型（不含 relation，relation 需要目标模型信息） */
const PRISMA_SCALAR: Partial<Record<FieldType, string>> = {
  string: 'String',
  text: 'String',
  number: 'Float',
  integer: 'Int',
  boolean: 'Boolean',
  date: 'DateTime',
  datetime: 'DateTime',
  object: 'Json',
  array: 'Json',
  file: 'String',
  json: 'Json',
};

export interface PrismaEmitOptions {
  /** datasource provider，默认 postgresql */
  provider?: 'postgresql' | 'mysql' | 'sqlite';
  /** 是否生成 enum 块（关闭时 enum 字段退化为 String） */
  enums?: boolean;
}

export interface PrismaEmitResult {
  schema: string;
  warnings: string[];
}

/** IR + 图索引的组合。core-ir 的查询函数是自由函数（第一个参数是 ir），
 *  所以内部统一传这个 ctx，避免每个辅助函数都多一个参数。 */
interface Ctx {
  ir: IR;
  g: GraphIndex;
}

interface RelationSide {
  table: TableNode;
  field: Field;
  /** 反向关系字段名 */
  backField: string;
}

/**
 * 收集所有外键，按目标表分组，用于给目标表补反向关系字段。
 *
 * 反向字段名取来源表名的驼峰 + 's'（`Device` → `devices`），重名时加数字后缀。
 * 不这么做的后果：两张表都引用同一张表时，Prisma 会因反向字段重名而报错，
 * 而报错信息指向的是「关系名冲突」而不是「你少写了一个 relation」，很难定位。
 */
function collectRelations(ctx: Ctx): Map<string, RelationSide[]> {
  const { ir, g } = ctx;
  const byTarget = new Map<string, RelationSide[]>();
  const used = new Map<string, Set<string>>();

  for (const table of sortedTables(ir)) {
    for (const field of table.table.fields) {
      const ref = field.constraints?.ref;
      if (ref === undefined) continue;
      const target = getTable(ir, ref.tableId);
      if (target === undefined) continue;

      const targetUsed = used.get(target.id) ?? new Set<string>();
      used.set(target.id, targetUsed);

      const base = toCamelCase(table.codeName || table.name);
      let backField = base.endsWith('s') ? base : `${base}s`;
      let n = 2;
      while (targetUsed.has(backField)) {
        backField = `${base}${n}`;
        n += 1;
      }
      targetUsed.add(backField);

      const list = byTarget.get(target.id) ?? [];
      list.push({ table, field, backField });
      byTarget.set(target.id, list);
    }
  }
  return byTarget;
}

function isPrimaryKey(g: GraphIndex, table: TableNode, field: Field): boolean {
  return g.primaryKey.get(table.id)?.id === field.id;
}

function relationFieldName(field: Field): string {
  // Prisma 里 relation 标量与关系字段不能同名，惯例是标量叫 deviceId、关系叫 device
  const base = field.name.endsWith('Id') ? field.name.slice(0, -2) : `${field.name}Rel`;
  return base.length > 0 ? base : 'relation';
}

function defaultOf(field: Field, type: FieldType): string | undefined {
  const value = field.constraints?.default;
  if (value === undefined) return undefined;
  if (type === 'boolean') return String(value);
  if (type === 'integer' || type === 'number') return String(value);
  if (type === 'datetime' || type === 'date') return String(value);
  return JSON.stringify(value);
}

function scalarLine(ctx: Ctx, table: TableNode, field: Field): string {
  const { ir, g } = ctx;
  const pk = isPrimaryKey(g, table, field);
  const ref = field.constraints?.ref;
  const enumRef = field.constraints?.enumRef;

  // 外键列：类型必须与目标主键一致，不能一律 String
  let base: string;
  if (ref !== undefined) {
    const target = getTable(ir, ref.tableId);
    const targetField =
      ref.fieldId !== undefined
        ? target?.table.fields.find((f) => f.id === ref.fieldId)
        : target !== undefined
          ? g.primaryKey.get(target.id)
          : undefined;
    base = targetField === undefined ? 'String' : (PRISMA_SCALAR[targetField.type] ?? 'String');
  } else if (field.type === 'enum') {
    base = enumRef !== undefined ? (g.enums.get(enumRef)?.name ?? 'String') : 'String';
  } else {
    base = PRISMA_SCALAR[field.type] ?? 'String';
  }

  const optional = pk ? '' : field.required && !field.nullable ? '' : '?';
  const parts = [`${field.name}`, `${base}${optional}`];

  if (pk) {
    const generated = field.name === 'id' && (field.type === 'integer' || field.type === 'number');
    if (generated) parts.push('@id', '@default(autoincrement())');
    else parts.push('@id', '@default(cuid())');
  } else {
    const def = defaultOf(field, field.type);
    if (def !== undefined) parts.push(`@default(${def})`);
  }

  // 唯一性只在单列索引上体现，复合索引用 @@unique 表达
  const uniq = table.table.indexes.some((i) => i.unique && i.fieldIds.length === 1 && i.fieldIds[0] === field.id);
  if (uniq && !pk) parts.push('@unique');

  if (field.dbName !== undefined && field.dbName !== toSnakeCase(field.name)) {
    parts.push(`@map("${field.dbName}")`);
  }

  return parts.join(' ');
}

function relationLines(ctx: Ctx, table: TableNode, relations: RelationSide[]): string[] {
  const { ir, g } = ctx;
  const lines: string[] = [];

  // 出边（本表持有外键）：必须写 fields / references，否则 Prisma 认为它是反向关系
  for (const field of table.table.fields) {
    const ref = field.constraints?.ref;
    if (ref === undefined) continue;
    const target = getTable(ir, ref.tableId);
    if (target === undefined) continue;
    const targetPk = ref.fieldId !== undefined
      ? target.table.fields.find((f) => f.id === ref.fieldId)
      : g.primaryKey.get(target.id);
    if (targetPk === undefined) continue;

    const optional = field.required && !field.nullable ? '' : '?';
    const onDelete = ref.onDelete !== undefined ? `, onDelete: ${mapOnDelete(ref.onDelete)}` : '';
    lines.push(
      `  ${relationFieldName(field)} ${toPascalCase(target.codeName || target.name)}${optional} @relation(fields: [${field.name}], references: [${targetPk.name}]${onDelete})`,
    );
  }

  // 入边（其他表引用本表）：列表型反向字段，无 @relation 属性
  for (const side of relations) {
    lines.push(`  ${side.backField} ${toPascalCase(side.table.codeName || side.table.name)}[]`);
  }

  return lines;
}

function mapOnDelete(value: 'restrict' | 'cascade' | 'setNull'): string {
  if (value === 'cascade') return 'Cascade';
  if (value === 'setNull') return 'SetNull';
  return 'Restrict';
}

/** Prisma 的 enum 值只能用 `[A-Za-z_][A-Za-z0-9_]*`，中文/短横线要退化 */
function isPrismaEnumValue(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

export function emitPrismaSchema(ir: IR, options: PrismaEmitOptions = {}): PrismaEmitResult {
  const ctx: Ctx = { ir, g: buildGraphIndex(ir) };
  const { g } = ctx;
  const provider = options.provider ?? 'postgresql';
  const withEnums = options.enums ?? true;
  const warnings: string[] = [];
  const w = new Writer();

  w.line('// @dsg:generated file=prisma/schema.prisma generator=nestjs@0.1.0');
  w.line('// 由 IR 的表节点生成。手改会与下次生成冲突，需要长期保留的改动请写在迁移文件里。');
  w.blank();
  w.line('generator client {');
  w.line('  provider = "prisma-client-js"');
  w.line('}');
  w.blank();
  w.line('datasource db {');
  w.line(`  provider = "${provider}"`);
  // Prisma 7 起 `url` 不再允许出现在 schema 里（错误码 P1012：The datasource
  // property `url` is no longer supported）。连接串改由 prisma.config.ts 的
  // `datasource.url` 提供，否则新生成的项目第一步 `prisma generate` 就失败。
  w.line('}');

  const relations = collectRelations(ctx);

  // ── enum ──
  const usedEnumIds = new Set<string>();
  for (const table of sortedTables(ir)) {
    for (const field of table.table.fields) {
      const ref = field.constraints?.enumRef;
      if (ref !== undefined) usedEnumIds.add(ref);
    }
  }
  if (withEnums) {
    for (const def of sortedEnums(ir)) {
      if (!usedEnumIds.has(def.id)) continue;
      emitEnum(w, def, warnings);
    }
  } else if (usedEnumIds.size > 0) {
    warnings.push(`关闭了 enum 生成，${usedEnumIds.size} 个枚举字段退化为 String`);
  }

  // ── model ──
  for (const table of sortedTables(ir)) {
    emitModel(w, ctx, table, relations.get(table.id) ?? [], withEnums, warnings);
  }

  return { schema: w.toString(), warnings };
}

function emitEnum(w: Writer, def: EnumDef, warnings: string[]): void {
  w.blank();
  w.line(`enum ${toPascalCase(def.name)} {`);
  for (const value of def.values) {
    if (!isPrismaEnumValue(value.value)) {
      // Prisma 不接受这类值，而静默丢弃会让枚举少一项且没有痕迹
      warnings.push(`枚举 ${def.name} 的值「${value.value}」不是合法标识符，已跳过`);
      continue;
    }
    w.line(`  ${value.value}`);
    void value.label;
  }
  w.line('}');
}

function emitModel(
  w: Writer,
  ctx: Ctx,
  table: TableNode,
  relations: RelationSide[],
  withEnums: boolean,
  warnings: string[],
): void {
  void withEnums;
  const { g } = ctx;
  const modelName = toPascalCase(table.codeName || table.name);
  w.blank();
  if (table.table.comment !== undefined) w.line(`/// ${table.table.comment.replace(/\r?\n/g, ' ')}`);
  w.line(`model ${modelName} {`);

  for (const field of table.table.fields) {
    w.line(`  ${scalarLine(ctx, table, field)}`);
  }

  // Prisma 要求关系两侧都在，所以关系字段紧跟标量字段之后
  for (const line of relationLines(ctx, table, relations)) w.line(line);

  // 时间戳与软删除：IR 开关为准
  const names = new Set(table.table.fields.map((f) => f.name));
  if (table.table.timestamps) {
    if (!names.has('createdAt')) {
      w.line('  createdAt DateTime @default(now())');
      if (table.table.fields.some((f) => f.name === 'createdAt')) {
        warnings.push(`${modelName} 已有 createdAt 字段，未追加时间戳`);
      }
    }
    if (!names.has('updatedAt')) w.line('  updatedAt DateTime @updatedAt');
  }
  if (table.table.softDelete && !names.has('deletedAt')) {
    w.line('  deletedAt DateTime?');
  }

  // 复合索引。Prisma 惯例：字段与块级属性之间空一行，否则整个 model 挤成一坨
  const blocks: string[] = [];
  for (const index of table.table.indexes) {
    const cols = index.fieldIds
      .map((id) => table.table.fields.find((f) => f.id === id))
      .filter((f): f is Field => f !== undefined)
      .map((f) => f.name);
    if (cols.length === 0) continue;
    if (cols.length === 1 && index.unique) continue; // 已在字段上 @unique
    const kind = index.unique ? '@@unique' : '@@index';
    blocks.push(`  ${kind}([${cols.join(', ')}]${index.name !== undefined ? `, map: "${index.name}"` : ''})`);
  }

  // @@map 无条件写：dbName 是 IR 的权威物理名，靠「猜」是否与模型名一致迟早出错
  blocks.push(`  @@map("${table.table.dbName}")`);

  w.blank();
  for (const line of blocks) w.line(line);

  w.line('}');
}
