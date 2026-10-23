/**
 * 示例数据的三种「可直接用」导出：
 * - `.http`：JetBrains / VS Code REST Client 能直接点的请求文件
 * - `postman-collection.json`：Postman v2.1，能直接 import
 * - `seed.sql`：直接灌进数据库的 INSERT
 *
 * 为什么值得单独做：`seed.json` 只是数据，用户还得自己拼请求、自己写 INSERT。
 * 而这三个格式的拼装规则是死的，手写一遍每个人都写错一次（SQL 没转义引号、
 * postman 的 url 对象结构不对）。
 */
import { fieldToDbName, type ApiNode, type Field, type IR, type TableNode } from '@fsdt/core-ir';

import type { SampleResult, SampleRow } from './generate.js';

export interface ExportSampleOptions {
  /** 服务地址，默认 http://localhost:3000 */
  baseUrl?: string;
  /** API 前缀，默认 /api（与生成的 NestJS main.ts 的 setGlobalPrefix 一致） */
  apiPrefix?: string;
  /** 生成的 JSON 缩进，默认 2 */
  indent?: number;
}

function normalize(options: ExportSampleOptions): Required<ExportSampleOptions> {
  return {
    baseUrl: options.baseUrl ?? 'http://localhost:3000',
    apiPrefix: options.apiPrefix ?? '/api',
    indent: options.indent ?? 2,
  };
}

/** 表节点 → 示例里第一行；找不到返回 undefined */
function firstRowOf(result: SampleResult, tableNodeId: string): SampleRow | undefined {
  return result.tables.find((t) => t.nodeId === tableNodeId)?.rows[0];
}

function pathParamsOf(path: string): string[] {
  const out: string[] = [];
  const re = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(path)) !== null) {
    if (m[1] !== undefined) out.push(m[1]);
  }
  return out;
}

/**
 * 把 `{id}` 换成示例值。
 *
 * 路径参数名通常就是主键名（id / deviceId），所以在「本接口引用的表」的第一行里
 * 找同名字段；找不到就保留 `{id}` 占位——留占位比塞一个假值更容易发现要手改。
 */
function resolvePath(ir: IR, api: ApiNode, result: SampleResult, apiPrefix: string): string {
  let path = api.api.path;
  const params = pathParamsOf(path);
  if (params.length === 0) return `${apiPrefix}${path}`;

  // 接口引用的表：用响应字段反查（响应字段名 → 某张表的同名字段）
  const responseNames = new Set(api.api.responses.flatMap((r) => r.fields.map((f) => f.name)));
  const table = ir.nodes.find(
    (n) => n.kind === 'table' && n.table.fields.some((f) => responseNames.has(f.name)),
  ) as TableNode | undefined;
  const row = table !== undefined ? firstRowOf(result, table.id) : undefined;

  for (const name of params) {
    const value = row?.[name];
    if (value !== undefined && value !== null) {
      path = path.replace(`{${name}}`, encodeURIComponent(String(value)));
    }
  }
  return `${apiPrefix}${path}`;
}

function queryPairsOf(api: ApiNode, result: SampleResult): Array<{ key: string; value: string }> {
  const pairs: Array<{ key: string; value: string }> = [];
  for (const field of api.api.query) {
    let value = '';
    if (field.name === 'page') value = '1';
    else if (field.name === 'pageSize') value = '20';
    else if (field.example !== undefined) value = String(field.example);
    pairs.push({ key: field.name, value });
  }
  // 让示例请求带上真实数据：拿接口响应字段名去表的第一行里取值
  if (pairs.length > 0) {
    const responseNames = new Set(api.api.responses.flatMap((r) => r.fields.map((f) => f.name)));
    const table = result.tables.find((t) => t.rows.some((r) => Object.keys(r).some((k) => responseNames.has(k))));
    const row = table?.rows[0];
    if (row !== undefined) {
      for (const pair of pairs) {
        if (pair.key === 'page' || pair.key === 'pageSize') continue;
        const value = row[pair.key];
        if (value !== undefined && value !== null) pair.value = String(value);
      }
    }
  }
  return pairs;
}

function bodyOf(api: ApiNode, result: SampleResult): Record<string, unknown> | undefined {
  const fields = api.api.requestBody?.fields;
  if (fields === undefined || fields.length === 0) return undefined;

  // 取值优先级：字段自己的 example → 任意一张表里同名字段的示例值 → 类型占位。
  // 不按「本接口响应字段反查表」来找，是因为创建类接口的响应字段常常叫
  // deviceId 而请求体叫 name，两边对不上就拿不到值，只剩一堆 TODO。
  const allRows = result.tables.flatMap((t) => t.rows);
  const body: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.example !== undefined) {
      body[field.name] = field.example;
      continue;
    }
    const hit = allRows.find((row) => row[field.name] !== undefined && row[field.name] !== null);
    body[field.name] = hit?.[field.name] ?? placeholderFor(field);
  }
  return body;
}

function placeholderFor(field: Field): unknown {
  switch (field.type) {
    case 'integer':
    case 'number':
      return 0;
    case 'boolean':
      return false;
    case 'date':
      return '2026-01-01';
    case 'datetime':
      return '2026-01-01T00:00:00.000Z';
    case 'array':
      return [];
    case 'object':
    case 'json':
      return {};
    case 'enum':
      return field.constraints?.enumValues?.[0] ?? 'TODO';
    default:
      return 'TODO';
  }
}

const APIs_OF = (ir: IR): ApiNode[] => ir.nodes.filter((n): n is ApiNode => n.kind === 'api');

// ────────────────────────────── .http ──────────────────────────────

export function toHttpFile(ir: IR, result: SampleResult, options: ExportSampleOptions = {}): string {
  const opts = normalize(options);
  const lines: string[] = [
    '### 由 fsdt 从 design/ir.json 生成',
    `### 示例数据 seed=${result.seed}，同一 seed 生成结果稳定`,
    '',
  ];

  for (const api of APIs_OF(ir)) {
    const url = `${opts.baseUrl}${resolvePath(ir, api, result, opts.apiPrefix)}`;
    const query = queryPairsOf(api, result);
    const queryString = query.length > 0 ? `?${query.map((q) => `${q.key}=${q.value}`).join('&')}` : '';
    lines.push(`### ${api.name}${api.api.summary.length > 0 ? ` — ${api.api.summary}` : ''}`);
    lines.push(`${api.api.method} ${url}${queryString}`);

    const body = bodyOf(api, result);
    if (body !== undefined) {
      lines.push('Content-Type: application/json');
      lines.push('');
      lines.push(JSON.stringify(body, null, opts.indent));
    }
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

// ────────────────────────────── postman ──────────────────────────────

export interface PostmanCollection {
  info: { name: string; schema: string; description?: string };
  variable: Array<{ key: string; value: string }>;
  item: Array<{
    name: string;
    request: {
      method: string;
      header: Array<{ key: string; value: string }>;
      url: {
        raw: string;
        host: string[];
        path: string[];
        query?: Array<{ key: string; value: string }>;
      };
      body?: { mode: 'raw'; raw: string; options: { raw: { language: 'json' } } };
    };
    response: unknown[];
  }>;
}

export function toPostmanCollection(
  ir: IR,
  result: SampleResult,
  options: ExportSampleOptions = {},
): PostmanCollection {
  const opts = normalize(options);
  const host = ['{{baseUrl}}'];

  const item = APIs_OF(ir).map((api) => {
    const fullPath = resolvePath(ir, api, result, opts.apiPrefix);
    const path = fullPath.split('/').filter((s) => s.length > 0);
    const query = queryPairsOf(api, result);
    const body = bodyOf(api, result);
    const raw = [
      `{{baseUrl}}${fullPath}`,
      query.length > 0 ? `?${query.map((q) => `${q.key}=${q.value}`).join('&')}` : '',
    ].join('');

    return {
      name: api.name,
      request: {
        method: api.api.method,
        header: body !== undefined ? [{ key: 'Content-Type', value: 'application/json' }] : [],
        url: {
          raw,
          host,
          path,
          ...(query.length > 0 ? { query } : {}),
        },
        ...(body !== undefined
          ? {
              body: {
                mode: 'raw' as const,
                raw: JSON.stringify(body, null, opts.indent),
                options: { raw: { language: 'json' as const } },
              },
            }
          : {}),
      },
      response: [],
    };
  });

  return {
    info: {
      name: `${ir.project.name} · fsdt`,
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
      description: `由 fsdt 从 design/ir.json 生成，示例数据 seed=${result.seed}。`,
    },
    variable: [{ key: 'baseUrl', value: `${opts.baseUrl}${opts.apiPrefix}` }],
    item,
  };
}

// ────────────────────────────── seed.sql ──────────────────────────────

function sqlValue(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (value instanceof Date) return `'${value.toISOString()}'`;
  if (typeof value === 'object') return `'${JSON.stringify(value).replace(/'/g, "''")}'`;
  // 单引号必须转义成两个单引号：否则名字里一个 ' 就能让整条 INSERT 语法错误
  return `'${String(value).replace(/'/g, "''")}'`;
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export interface SeedSqlOptions extends ExportSampleOptions {
  /** 表名/列名是否加双引号，默认 true（大小写敏感的库必须加） */
  quoteIdentifiers?: boolean;
  /** 每次 INSERT 的行数，默认 100（避免单条语句过长） */
  rowsPerStatement?: number;
}

export function toSeedSql(ir: IR, result: SampleResult, options: SeedSqlOptions = {}): string {
  const ident = options.quoteIdentifiers ?? true;
  const batch = Math.max(1, options.rowsPerStatement ?? 100);
  const q = (name: string): string => (ident ? quoteIdent(name) : name);
  const lines: string[] = [
    '-- 由 fsdt 从 design/ir.json 生成',
    `-- 示例数据 seed=${result.seed}，同一 seed 生成结果稳定`,
    '-- 注意：这是演示数据，不要在生产库执行',
    '',
  ];

  for (const table of result.tables) {
    const node = ir.nodes.find((n) => n.id === table.nodeId);
    if (node === undefined || node.kind !== 'table') continue;
    if (table.rows.length === 0) continue;

    const fields = node.table.fields.filter((f) => f.writeOnly !== true);
    const columns = fields.map((f) => q(f.dbName ?? fieldToDbName(f.name, ir.settings.naming)));
    lines.push(`-- ${node.name}（${table.rows.length} 行）`);
    if (node.table.softDelete) {
      lines.push('-- 该表启用了软删除，deletedAt 保持 NULL');
    }

    for (let start = 0; start < table.rows.length; start += batch) {
      const chunk = table.rows.slice(start, start + batch);
      const values = chunk.map(
        (row) => `  (${fields.map((f) => sqlValue(row[f.name])).join(', ')})`,
      );
      lines.push(`INSERT INTO ${q(table.dbName)} (${columns.join(', ')}) VALUES`);
      lines.push(`${values.join(',\n')};`);
      lines.push('');
    }
  }

  if (result.warnings.length > 0) {
    lines.push('-- 生成时的提示：');
    for (const warning of result.warnings) lines.push(`--   ${warning}`);
  }

  return `${lines.join('\n')}\n`;
}
