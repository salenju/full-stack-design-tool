/**
 * IR → 示例数据。
 *
 * 三条硬要求：
 * 1. **确定性**：同一 IR + 同一 seed，两次生成必须字节一致。否则 `fsdt gen --check`
 *    永远报漂移，示例数据也没法进 git review。
 * 2. **引用完整性**：外键字段的值必须真的存在于目标表里；否则生成的 mock 数据
 *    一插库就报错，用户还得手工改——那不如不生成。
 * 3. **逐格独立随机**：每个单元格的种子 = hash(seed, 表ID, 行号, 字段ID)。
 *    这样给表加一个字段，其他字段的值不会全变（否则每次加字段 diff 都是整表重写）。
 *
 * 为什么不用 faker：faker 的输出跨版本会变（它自己在 changelog 里说明不保证稳定），
 * 一旦升级，黄金样例全红。这里用内置词表 + 确定性 PRNG，牺牲一点真实感换稳定。
 */

import { buildGraphIndex, toCamelCase, type Field, type IR, type TableNode } from '@fsdt/core-ir';

import { createRng, hashSeed, type Rng } from './rng.js';
import { detectSemantic, isSensitive, type SemanticKind } from './semantic.js';

// ────────────────────────────── 输出结构 ──────────────────────────────

export interface SampleRow {
  [field: string]: unknown;
}

export interface TableSample {
  /** 表节点 ID */
  nodeId: string;
  /** 代码里的模型名 */
  modelName: string;
  /** 数据库表名 */
  dbName: string;
  rows: SampleRow[];
}

export interface SampleOptions {
  /** 全局种子，缺省取 settings.generation.sampleSeed */
  seed?: number;
  /** 每张表的行数，缺省 5 */
  rowsPerTable?: number;
  /** 是否尊重 field.example（缺省 true） */
  useFieldExample?: boolean;
  /** 是否尊重 field.locked 的现有值（缺省 true） */
  useLocked?: boolean;
}

export interface SampleResult {
  /** 按表名排序的样本，保证输出稳定 */
  tables: TableSample[];
  seed: number;
  warnings: string[];
}

// ────────────────────────────── 词表 ──────────────────────────────

const FIRST_NAMES = ['伟', '芳', '娜', '秀英', '敏', '静', '丽', '强', '磊', '洋', '艳', '勇', '军', '杰', '娟', '涛', '明', '超', '秀兰', '霞'];
const LAST_NAMES = ['王', '李', '张', '刘', '陈', '杨', '赵', '黄', '周', '吴', '徐', '孙', '马', '朱', '胡'];
const COMPANY_PREFIX = ['云生', '星海', '启明', '领航', '橙心', '跃迁', '恒远', '朗峰', '中科', '中新'];
const COMPANY_SUFFIX = ['科技有限公司', '信息技术有限公司', '网络科技有限公司', '数据服务有限公司'];
const CITY = ['北京市', '上海市', '广州市', '深圳市', '杭州市', '成都市', '武汉市', '西安市'];
const DISTRICT = ['朝阳区', '海淀区', '浦东新区', '天河区', '南山区', '西湖区', '高新区', '雁塔区'];
const STREET = ['科技路', '人民大道', '中山路', '建设路', '创业大街', '金融街', '文化路', '新华路'];
const EMAIL_DOMAINS = ['example.com', 'example.org', 'test.example'];
const DEVICE_WORDS = ['网关', '传感器', '采集器', '控制器', '路由器', '终端', '一体机', '摄像头'];
const TITLE_WORDS = ['月度报告', '需求评审', '设备巡检', '版本发布', '异常处理', '性能优化', '数据核对', '安全审计'];
const DESC_WORDS = ['常规处理，无需额外说明。', '该记录由系统自动生成。', '待补充详细描述。', '已按最新方案调整。', '需与业务方进一步确认。'];
const TAG_WORDS = ['重点', '常规', '紧急', '归档', '测试'];
const COLOR_VALUES = ['#409EFF', '#67C23A', '#E6A23C', '#F56C6C', '#909399', '#00BCD4'];
const FILE_NAMES = ['需求文档', '设备清单', '巡检记录', '接口说明', '数据导出'];
const FILE_EXTS = ['pdf', 'docx', 'xlsx', 'png'];

// ────────────────────────────── 生成器 ──────────────────────────────

interface CellContext {
  field: Field;
  row: number;
  semantic: SemanticKind;
  rng: Rng;
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

function isoDate(base: Date, offsetDays: number): string {
  const d = new Date(base.getTime() + offsetDays * 86400000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1, 2)}-${pad(d.getUTCDate(), 2)}`;
}

function isoDateTime(base: Date, offsetSeconds: number): string {
  const d = new Date(base.getTime() + offsetSeconds * 1000);
  return `${isoDate(d, 0)}T${pad(d.getUTCHours(), 2)}:${pad(d.getUTCMinutes(), 2)}:${pad(d.getUTCSeconds(), 2)}Z`;
}

/** 造数的基准时间点：固定为 2024-01-01，不用 Date.now()，否则每次生成都不同 */
const BASE_DATE = new Date(Date.UTC(2024, 0, 1, 0, 0, 0));

function generateBySemantic(ctx: CellContext, tableName: string): unknown {
  const { field, row, semantic, rng } = ctx;

  // 字符串类语义统一在此返回，数值/时间类按 type 另有分支
  switch (semantic) {
    case 'email':
      return `user${pad(row + 1, 3)}@${rng.pick(EMAIL_DOMAINS)}`;
    case 'phone':
      return `1${rng.int(3, 9)}${String(rng.int(0, 999999999)).padStart(9, '0')}`;
    case 'url':
      return `https://example.com/${toCamelCase(tableName).toLowerCase()}/${row + 1}`;
    case 'imageUrl':
      return `https://picsum.photos/seed/${hashSeed(field.id + row) % 1000}/200/200`;
    case 'ip':
      return `192.168.${rng.int(0, 255)}.${rng.int(1, 254)}`;
    case 'uuid':
      return deterministicUuid(rng);
    case 'color':
      return rng.pick(COLOR_VALUES);
    case 'address':
      return `${rng.pick(CITY)}${rng.pick(DISTRICT)}${rng.pick(STREET)}${rng.int(1, 999)}号`;
    case 'company':
      return `${rng.pick(COMPANY_PREFIX)}${rng.pick(COMPANY_SUFFIX)}`;
    case 'personName':
      return `${rng.pick(LAST_NAMES)}${rng.pick(FIRST_NAMES)}`;
    case 'title':
      return `${rng.pick(TITLE_WORDS)}（第 ${row + 1} 期）`;
    case 'description':
      return rng.pick(DESC_WORDS);
    case 'fileName':
      return `${rng.pick(FILE_NAMES)}_${pad(row + 1, 2)}.${rng.pick(FILE_EXTS)}`;
    case 'name':
      return `${rng.pick(DEVICE_WORDS)}${pad(row + 1, 2)}`;
    case 'code':
      return `${toCamelCase(tableName).slice(0, 3).toUpperCase()}${pad(row + 1, 6)}`;
    case 'id':
      return row + 1;
    case 'amount':
      return Math.round((rng.next() * 9999 + 1) * 100) / 100;
    case 'percent':
      return rng.int(0, 100);
    case 'count':
      return rng.int(1, 500);
    case 'age':
      return rng.int(18, 65);
    case 'timestamp':
      return typeDefault(field, rng, row);
    case 'dateOnly':
      return typeDefault(field, rng, row);
    case 'booleanFlag':
      return typeDefault(field, rng, row);
    default:
      return typeDefault(field, rng, row);
  }
}

function deterministicUuid(rng: Rng): string {
  const hex = '0123456789abcdef';
  const chars: string[] = [];
  for (let i = 0; i < 32; i += 1) chars.push(hex[rng.int(0, 15)]!);
  // 版本 4 / variant 10xx，让生成值看起来像真 UUID
  chars[12] = '4';
  chars[16] = '89ab'[rng.int(0, 3)]!;
  return `${chars.slice(0, 8).join('')}-${chars.slice(8, 12).join('')}-${chars.slice(12, 16).join('')}-${chars.slice(16, 20).join('')}-${chars.slice(20).join('')}`;
}

/** 按字段类型产默认值（语义识别失败时走这里） */
function typeDefault(field: Field, rng: Rng, row: number): unknown {
  switch (field.type) {
    case 'string':
      return `${field.name}_${row + 1}`;
    case 'text':
      return `这是 ${field.comment ?? field.name} 的示例文本（第 ${row + 1} 条）。`;
    case 'integer':
      return rng.int(1, 1000);
    case 'number':
      return Math.round(rng.next() * 10000) / 100;
    case 'boolean':
      return rng.chance(0.5);
    case 'date':
      return isoDate(BASE_DATE, rng.int(0, 365));
    case 'datetime':
      return isoDateTime(BASE_DATE, rng.int(0, 365 * 86400));
    case 'file':
      return `https://example.com/files/${field.name}_${row + 1}.pdf`;
    case 'json':
      return { key: `value_${row + 1}` };
    case 'object':
      return {};
    case 'array':
      return [];
    default:
      return null;
  }
}

/** 数字字段的约束裁剪：优先用 min/max，其次用语义合理区间 */
function clampNumber(value: number, field: Field, isInteger: boolean): number {
  let v = value;
  const min = field.constraints?.minimum;
  const max = field.constraints?.maximum;
  if (min !== undefined && v < min) v = min;
  if (max !== undefined && v > max) v = max;
  if (isInteger) v = Math.round(v);
  const precision = field.constraints?.precision;
  if (!isInteger && precision !== undefined) {
    const factor = 10 ** precision;
    v = Math.round(v * factor) / factor;
  }
  return v;
}

function generateCell(
  field: Field,
  tableSeed: string,
  tableName: string,
  row: number,
  options: Required<Pick<SampleOptions, 'useFieldExample' | 'useLocked'>>,
): unknown {
  if (options.useFieldExample && field.example !== undefined) return field.example;
  if (options.useLocked && field.locked === true && field.example !== undefined) return field.example;

  const rng = createRng(hashSeed(`${tableSeed}:${field.id}:${row}`));
  const semantic = detectSemantic(field);

  if (field.type === 'boolean') {
    // boolean 不走语义识别：名字里带 is_ 不代表一定为 true
    return rng.chance(0.5);
  }

  let value: unknown;
  if (field.type === 'number' || field.type === 'integer') {
    value = generateBySemantic({ field, row, semantic, rng }, tableName);
    if (typeof value === 'number') value = clampNumber(value, field, field.type === 'integer');
  } else {
    value = generateBySemantic({ field, row, semantic, rng }, tableName);
  }

  // 字符串约束裁剪：只在超限时截断，不主动填充。
  // 注意用局部变量而不是直接改写 value：value 声明为 unknown，一旦重新赋值
  // 类型收窄就会丢回 unknown，后面所有 .length 都要再断言一次。
  if (typeof value === 'string') {
    let text = value;
    const maxLength = field.constraints?.maxLength;
    if (maxLength !== undefined && text.length > maxLength) text = text.slice(0, maxLength);
    const minLength = field.constraints?.minLength;
    if (minLength !== undefined && text.length < minLength) text = text.padEnd(minLength, '0');
    const pattern = field.constraints?.pattern;
    if (pattern !== undefined) {
      try {
        if (!new RegExp(pattern).test(text)) {
          // 不猜正则意图，退回字段名占位，让用户一眼看出没造对
          text = `${field.name}_${row + 1}`;
        }
      } catch {
        // 非法正则交给 Lint 报，这里不阻断
      }
    }
    return text;
  }

  return value;
}

/** 枚举字段：从字典或内联值里挑 */
function enumValuesOf(ir: IR, field: Field): string[] {
  const ref = field.constraints?.enumRef;
  if (ref !== undefined) {
    const def = ir.dictionaries.enums.find((e) => e.id === ref);
    if (def !== undefined) return def.values.map((v) => v.value);
  }
  return field.constraints?.enumValues ?? [];
}

interface TablePlan {
  table: TableNode;
  primaryKey: Field | undefined;
  /** 外键字段 → 目标表节点 */
  foreignKeys: Map<string, { target: TableNode; targetField: Field | undefined }>;
}

/**
 * 拓扑排序：被引用的表先造数，这样外键才有值可挑。
 * 遇到环（自引用或互相引用）时不断言失败，只在环内表之间按名称顺序造，
 * 并把外键值留空——环上的外键本来就是「可空」的语义。
 */
function orderTables(plans: Map<string, TablePlan>): { ordered: string[]; cyclic: Set<string> } {
  const ordered: string[] = [];
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const cyclic = new Set<string>();

  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (inStack.has(id)) {
      cyclic.add(id);
      return;
    }
    inStack.add(id);
    const plan = plans.get(id);
    if (plan !== undefined) {
      for (const fk of plan.foreignKeys.values()) {
        if (fk.target.id !== id) visit(fk.target.id);
      }
    }
    inStack.delete(id);
    visited.add(id);
    ordered.push(id);
  };

  // 按节点 ID 排序遍历，保证排序结果本身也是确定的
  for (const id of [...plans.keys()].sort()) visit(id);
  return { ordered, cyclic };
}

export function generateSamples(ir: IR, options: SampleOptions = {}): SampleResult {
  const warnings: string[] = [];
  const seed = options.seed ?? ir.settings.generation.sampleSeed;
  const rowsPerTable = Math.max(1, options.rowsPerTable ?? 5);
  const useFieldExample = options.useFieldExample ?? true;
  const useLocked = options.useLocked ?? true;
  const cellOptions = { useFieldExample, useLocked };

  const g = buildGraphIndex(ir);

  // 建表计划：解析主键与外键
  const plans = new Map<string, TablePlan>();
  for (const node of ir.nodes) {
    if (node.kind !== 'table') continue;
    const primaryKey = g.primaryKey.get(node.id);
    if (primaryKey === undefined) {
      warnings.push(`表「${node.name}」没有主键，示例数据无法保证唯一`);
    }
    const foreignKeys = new Map<string, { target: TableNode; targetField: Field | undefined }>();
    for (const field of node.table.fields) {
      if (field.type !== 'ref') continue;
      const ref = field.constraints?.ref;
      if (ref === undefined) {
        warnings.push(`字段「${node.name}.${field.name}」声明为 ref 但没有指定目标表`);
        continue;
      }
      const targetNode = g.nodes.get(ref.tableId);
      if (targetNode === undefined || targetNode.kind !== 'table') {
        warnings.push(`字段「${node.name}.${field.name}」的外键目标 ${ref.tableId} 不存在`);
        continue;
      }
      const targetField =
        ref.fieldId !== undefined
          ? targetNode.table.fields.find((f) => f.id === ref.fieldId)
          : g.primaryKey.get(targetNode.id);
      foreignKeys.set(field.id, { target: targetNode, targetField });
    }
    plans.set(node.id, { table: node, primaryKey, foreignKeys });
  }

  const { ordered, cyclic } = orderTables(plans);
  if (cyclic.size > 0) {
    warnings.push(
      `检测到外键循环引用（${[...cyclic]
        .map((id) => plans.get(id)?.table.name ?? id)
        .join('、')}），环上的外键可能留空`,
    );
  }

  /** 已经造好的行，供外键挑选（表节点 ID → 行数组） */
  const generated = new Map<string, SampleRow[]>();

  const result: TableSample[] = [];

  for (const nodeId of ordered) {
    const plan = plans.get(nodeId);
    if (plan === undefined) continue;
    const { table, primaryKey, foreignKeys } = plan;
    const tableSeed = `${seed}:${table.id}`;
    const rows: SampleRow[] = [];
    // 先登记这个空数组，再逐行 push：这样「自引用外键」（树形结构）能在造后续行时
    // 看到前面已经造好的行，从而挑到真实存在的父节点，而不是一律留 null。
    generated.set(table.id, rows);

    for (let row = 0; row < rowsPerTable; row += 1) {
      const sample: SampleRow = {};

      for (const field of table.table.fields) {
        // 主键：优先用自增整数，其次用 (row+1) 作字符串，保证外键能稳定指向
        if (primaryKey !== undefined && field.id === primaryKey.id) {
          sample[field.name] = primaryKey.type === 'string' || primaryKey.type === 'text' ? `${toCamelCase(table.codeName).toUpperCase()}-${pad(row + 1, 4)}` : row + 1;
          continue;
        }

        const fk = foreignKeys.get(field.id);
        if (fk !== undefined) {
          const pool = generated.get(fk.target.id) ?? [];
          if (pool.length === 0) {
            // 循环引用或目标表为空：外键留 null，而不是编一个假 ID
            sample[field.name] = null;
            continue;
          }
          const picked = pool[pickRowIndex(createRng(hashSeed(`${tableSeed}:fk:${field.id}:${row}`)), pool.length)]!;
          const targetKey =
            fk.targetField !== undefined ? picked[fk.targetField.name] : (Object.values(picked)[0] as unknown);
          sample[field.name] = targetKey ?? null;
          continue;
        }

        if (field.type === 'enum') {
          const values = enumValuesOf(ir, field);
          if (values.length === 0) {
            warnings.push(`枚举字段「${table.name}.${field.name}」没有可选值`);
            sample[field.name] = null;
          } else {
            const rng = createRng(hashSeed(`${tableSeed}:enum:${field.id}:${row}`));
            sample[field.name] = rng.pick(values);
          }
          continue;
        }

        if (field.type === 'array') {
          const itemType = field.constraints?.arrayItem ?? 'string';
          const rng = createRng(hashSeed(`${tableSeed}:arr:${field.id}:${row}`));
          const count = rng.int(0, 3);
          if (itemType === 'string') {
            sample[field.name] = Array.from({ length: count }, () => rng.pick(TAG_WORDS));
          } else if (itemType === 'integer' || itemType === 'number') {
            sample[field.name] = Array.from({ length: count }, () => rng.int(1, 100));
          } else {
            sample[field.name] = [];
          }
          continue;
        }

        sample[field.name] = generateCell(field, tableSeed, table.table.dbName, row, cellOptions);
      }

      // 敏感字段：标注在行上，导出 JSON 时由调用方决定是否脱敏
      rows.push(sample);
    }

    result.push({
      nodeId: table.id,
      modelName: toCamelCase(table.codeName).replace(/^./, (c) => c.toUpperCase()),
      dbName: table.table.dbName,
      rows,
    });
  }

  // 输出按表名排序，与造数顺序解耦（造数要按依赖序，输出要稳定）
  result.sort((a, b) => (a.dbName < b.dbName ? -1 : a.dbName > b.dbName ? 1 : 0));

  return { tables: result, seed, warnings: [...new Set(warnings)] };
}

function pickRowIndex(rng: Rng, length: number): number {
  return rng.int(0, length - 1);
}

// ────────────────────────────── 输出格式 ──────────────────────────────

export interface SampleOutputOptions {
  /** 脱敏：sensitive 字段替换为掩码 */
  maskSensitive?: boolean;
}

const MASK = '***';

/** 生成可直接入库的 JSON（按表名分组） */
export function toSeedJson(ir: IR, result: SampleResult, options: SampleOutputOptions = {}): Record<string, SampleRow[]> {
  const out: Record<string, SampleRow[]> = {};
  for (const table of result.tables) {
    const sensitiveNames = sensitiveFieldNames(ir, table.nodeId);
    out[table.dbName] = table.rows.map((row) => maskRow(row, sensitiveNames, options.maskSensitive ?? true));
  }
  return out;
}

function sensitiveFieldNames(ir: IR, nodeId: string): Set<string> {
  const names = new Set<string>();
  const node = ir.nodes.find((n) => n.id === nodeId);
  if (node === undefined || node.kind !== 'table') return names;
  for (const field of node.table.fields) {
    if (isSensitive(field)) names.add(field.name);
  }
  return names;
}

function maskRow(row: SampleRow, sensitiveNames: Set<string>, mask: boolean): SampleRow {
  if (!mask) return { ...row };
  const out: SampleRow = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = sensitiveNames.has(key) ? MASK : value;
  }
  return out;
}

/** 脱敏检查：用于 Lint 与生成时提示 */
export function sensitiveFieldWarnings(ir: IR, result: SampleResult): string[] {
  const warnings: string[] = [];
  for (const table of result.tables) {
    const node = ir.nodes.find((n) => n.id === table.nodeId);
    if (node === undefined || node.kind !== 'table') continue;
    for (const field of node.table.fields) {
      if (isSensitive(field)) {
        warnings.push(`敏感字段「${table.dbName}.${field.name}」的示例值在导出时默认脱敏`);
      }
    }
  }
  return warnings;
}

export { isSensitive };
