/**
 * Lint 引擎。
 *
 * 定位：**生成前的契约门禁**，不是代码风格检查。它回答一个问题：
 * 「这份 IR 拿去生成代码，会不会生成出跑不起来 / 语义错的东西？」
 *
 * 三条设计纪律：
 * 1. **只报能修的问题。** 报「建议加注释」这类主观项会把面板塞满，用户就再也不看了。
 *    唯一例外是 L004，默认关闭（见该规则注释）。
 * 2. **每条 issue 必须能定位。** target 里带 nodeId/fieldId/componentId，前端才能点击跳转；
 *    定位不了的检查不做。
 * 3. **修复建议必须是确定性的。** `fix` 只描述「怎么改」，不直接改 IR——改不改由用户决定。
 *    这样 Lint 保持纯函数，可以在服务端、CLI、CI 里跑而没有任何副作用。
 */

import { buildGraphIndex, toCamelCase, type IR, type IREdge, type PageComponent, type PageNode } from '@fsdt/core-ir';

// ────────────────────────────── 类型 ──────────────────────────────

export type LintSeverity = 'info' | 'warn' | 'error';

export interface LintTarget {
  nodeId?: string;
  fieldId?: string;
  edgeId?: string;
  componentId?: string;
  pageId?: string;
}

export type LintFix =
  | { kind: 'renameNode'; nodeId: string; from: string; to: string }
  | { kind: 'renameField'; fieldId: string; from: string; to: string }
  | { kind: 'setRoute'; pageId: string; from: string; to: string }
  | { kind: 'addPaginationParams'; apiNodeId: string }
  | { kind: 'addEnumValues'; fieldId: string }
  | { kind: 'bindField'; componentId: string; fieldId: string }
  | { kind: 'removeEdge'; edgeId: string };

export interface LintIssue {
  ruleId: string;
  severity: LintSeverity;
  message: string;
  target: LintTarget;
  fix?: LintFix;
}

export interface LintRule {
  id: string;
  /** 规则标题（面板上显示） */
  title: string;
  defaultSeverity: LintSeverity;
  /** 该规则检查什么、为什么重要 */
  description: string;
  run(ctx: LintContext): LintIssue[];
}

export interface LintContext {
  ir: IR;
  g: ReturnType<typeof buildGraphIndex>;
  /** 生成 issue 的辅助函数，自动补 ruleId 与 severity */
  report(rule: LintRule, message: string, target: LintTarget, fix?: LintFix): LintIssue;
}

export interface LintOptions {
  /** 只跑这些规则（缺省全部） */
  only?: string[];
  /** 不跑这些规则 */
  except?: string[];
  /** 覆盖严重度；'off' 表示关闭 */
  overrides?: Record<string, LintSeverity | 'off'>;
  /**
   * 忽略项。结构与 IR 里持久化的 `LintIgnore` 保持一致（`ruleId` + `targetId` + `reason`），
   * 这样前端「忽略此项」拿到的对象可以直接写回 IR，不需要再转换一次——
   * 两份形状不同的忽略结构必然会有一处忘同步，然后在「忽略不生效」上浪费半天。
   */
  ignores?: Array<{ ruleId: string; targetId: string; reason?: string }>;
}

export interface LintResult {
  issues: LintIssue[];
  /** 被忽略的 issue，仍返回供面板展示 */
  ignored: LintIssue[];
  stats: { error: number; warn: number; info: number };
  /** 是否有阻断性问题（error 级且未被忽略） */
  blocked: boolean;
}

// ────────────────────────────── 工具 ──────────────────────────────

const PATH_PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

function pathParamsOf(path: string): string[] {
  const out: string[] = [];
  for (const m of path.matchAll(PATH_PLACEHOLDER)) {
    if (m[1] !== undefined) out.push(m[1]);
  }
  return out;
}

/** 接口的请求体字段 ID 集合（不含响应） */
function requestFieldIds(g: ReturnType<typeof buildGraphIndex>, apiNodeId: string): Set<string> {
  const ids = new Set<string>();
  const node = g.nodes.get(apiNodeId);
  if (node === undefined || node.kind !== 'api') return ids;
  const api = node.api;
  for (const list of [api.pathParams, api.query, api.headers]) {
    for (const f of list) ids.add(f.id);
  }
  if (api.requestBody !== undefined) for (const f of api.requestBody.fields) ids.add(f.id);
  return ids;
}

/** 接口的响应体字段 ID 集合 */
function responseFieldIds(g: ReturnType<typeof buildGraphIndex>, apiNodeId: string): Set<string> {
  return new Set(g.apiResponseFieldIds.get(apiNodeId) ?? []);
}

function allComponents(page: PageNode): PageComponent[] {
  return page.page.components;
}

// ────────────────────────────── 规则 ──────────────────────────────

/** 规则实现的统一包装：省掉每条规则都写一遍 `const out = []; out.push(...)` */
function collect(ctx: LintContext, rule: LintRule, producer: (push: (m: string, t: LintTarget, f?: LintFix) => void) => void): LintIssue[] {
  const out: LintIssue[] = [];
  producer((message, target, fix) => {
    out.push(ctx.report(rule, message, target, fix));
  });
  return out;
}

const RULES: LintRule[] = [
  {
    id: 'L001',
    title: '页面动作未绑定任何接口或跳转',
    defaultSeverity: 'warn',
    description: '按钮点了没反应，生成的页面会有一个空 handler。',
    run(ctx) {
      return collect(ctx, this, (push) => {
        for (const page of ctx.g.pages) {
          for (const component of page.page.components) {
            if (component.type !== 'action') continue;
            if (component.apiRef !== undefined) continue;
            if (component.navigateTo !== undefined) continue;
            push(`动作「${component.title ?? component.id}」既没有绑定接口也没有配置跳转`, {
              nodeId: page.id,
              pageId: page.id,
              componentId: component.id,
            });
          }
        }
      });
    },
  },

  {
    id: 'L002',
    title: '连线指向不存在的节点',
    defaultSeverity: 'error',
    description: '画布上删了节点但连线还在，编译时会出现悬空引用。',
    run(ctx) {
      return collect(ctx, this, (push) => {
        for (const edge of ctx.ir.edges) {
          for (const end of [edge.source, edge.target]) {
            if (!ctx.g.nodes.has(end.nodeId)) {
              push(`连线 ${edge.id} 的${end === edge.source ? '起点' : '终点'}节点 ${end.nodeId} 不存在`, {
                edgeId: edge.id,
                nodeId: end.nodeId,
              }, { kind: 'removeEdge', edgeId: edge.id });
            }
          }
        }
      });
    },
  },

  {
    id: 'L003',
    title: '映射两端类型不兼容',
    defaultSeverity: 'error',
    description:
      'string 字段映射到 number 字段且没有转换函数，生成的代码会在运行时拿到错误类型，或直接把校验抛给用户。',
    run(ctx) {
      return collect(ctx, this, (push) => {
        for (const edge of ctx.ir.edges as IREdge[]) {
          if (edge.kind !== 'map') continue;
          const sourceFieldId = edge.source.fieldId;
          const targetFieldId = edge.target.fieldId;
          if (sourceFieldId === undefined || targetFieldId === undefined) continue;
          const source = ctx.g.fields.get(sourceFieldId);
          const target = ctx.g.fields.get(targetFieldId);
          if (source === undefined || target === undefined) continue;
          if (compatible(source.field.type, target.field.type)) continue;
          if (edge.transform !== undefined && edge.transform.fn !== 'identity') continue;
          push(
            `字段「${source.field.name}」(${source.field.type}) 映射到「${target.field.name}」(${target.field.type})，` +
              `类型不兼容且未配置转换函数`,
            { edgeId: edge.id, fieldId: sourceFieldId },
          );
        }
      });
    },
  },

  {
    id: 'L004',
    title: '响应字段缺少示例值',
    defaultSeverity: 'info',
    /**
     * 默认关闭（在 DEFAULT_OVERRIDES 里设为 off）。
     *
     * 原因：示例值现在是**编译期由 @fsdt/sample 注入**的（OpenAPI 导出时会带上），
     * 不需要用户手工填。这条规则如果默认开启，会对每个没手写 example 的字段报警，
     * 面板 100% 是这条噪音，用户就再也不看 Lint 了。
     * 只有需要「手工示例用于对外文档」的团队才该打开它。
     */
    description: '对外发布 OpenAPI 文档时，缺少示例值会让调用方难以理解字段含义。示例值通常由示例数据生成器注入。',
    run(ctx) {
      return collect(ctx, this, (push) => {
        for (const api of ctx.g.apis) {
          const ids = ctx.g.apiResponseFieldIds.get(api.id) ?? [];
          for (const fieldId of ids) {
            const loc = ctx.g.fields.get(fieldId);
            if (loc === undefined) continue;
            if (loc.field.example !== undefined) continue;
            push(`接口「${api.name}」的响应字段「${loc.field.name}」没有示例值`, {
              nodeId: api.id,
              fieldId,
            });
          }
        }
      });
    },
  },

  {
    id: 'L005',
    title: '必填字段在表单中无对应控件',
    defaultSeverity: 'warn',
    description: '接口要求必填，但页面表单没给输入框，用户提交时必然报校验错误却找不到地方填。',
    run(ctx) {
      return collect(ctx, this, (push) => {
        for (const page of ctx.g.pages) {
          for (const component of page.page.components) {
            if (component.type !== 'form') continue;
            const apiNode = ctx.g.nodes.get(component.apiRef);
            if (apiNode === undefined || apiNode.kind !== 'api') continue;
            const bound = new Set(component.bindings.map((b) => b.fieldRef));
            const bodyFields = apiNode.api.requestBody?.fields ?? [];
            for (const field of bodyFields) {
              if (!field.required) continue;
              if (field.readOnly === true) continue;
              if (!bound.has(field.id)) {
                push(
                  `接口「${apiNode.name}」的必填字段「${field.name}」在表单「${component.title ?? component.id}」里没有控件`,
                  { nodeId: page.id, pageId: page.id, componentId: component.id, fieldId: field.id },
                  { kind: 'bindField', componentId: component.id, fieldId: field.id },
                );
              }
            }
          }
        }
      });
    },
  },

  {
    id: 'L006',
    title: 'method + path 重复定义',
    defaultSeverity: 'error',
    description: 'OpenAPI 里同一 path 同一 method 只能有一个操作，重复会让生成器互相覆盖。',
    run(ctx) {
      return collect(ctx, this, (push) => {
        const seen = new Map<string, string>();
        for (const api of ctx.g.apis) {
          const key = `${api.api.method} ${api.api.path}`;
          const first = seen.get(key);
          if (first !== undefined) {
            push(`接口「${api.name}」与「${ctx.g.nodes.get(first)?.name ?? first}」重复定义了 ${key}`, {
              nodeId: api.id,
            });
          } else {
            seen.set(key, api.id);
          }
        }
      });
    },
  },

  {
    id: 'L007',
    title: '列表接口缺少分页参数',
    defaultSeverity: 'warn',
    description: 'GET 返回数组但没声明 page/pageSize，生成的分页表格只能全量拉取，数据一多就卡死。',
    run(ctx) {
      return collect(ctx, this, (push) => {
        for (const api of ctx.g.apis) {
          if (api.api.method !== 'GET') continue;
          const returnsArray = api.api.responses.some(
            (r) => r.shape === 'array' || (r.shape === 'object' && r.envelope?.totalKey !== undefined),
          );
          if (!returnsArray) continue;
          const names = new Set(api.api.query.map((f) => f.name));
          const hasPaging = names.has('page') || names.has('pageSize') || names.has('page_size') || names.has('limit');
          if (!hasPaging) {
            push(
              `接口「${api.name}」返回列表但没有声明分页参数（page / pageSize）`,
              { nodeId: api.id },
              { kind: 'addPaginationParams', apiNodeId: api.id },
            );
          }
        }
      });
    },
  },

  {
    id: 'L008',
    title: '枚举字段未声明取值范围',
    defaultSeverity: 'error',
    description: '枚举没有候选值，生成的 TS 类型会退化成 string，前后端都无法校验。',
    run(ctx) {
      return collect(ctx, this, (push) => {
        for (const [fieldId, loc] of ctx.g.fields) {
          if (loc.field.type !== 'enum') continue;
          const ref = loc.field.constraints?.enumRef;
          const inline = loc.field.constraints?.enumValues;
          const hasRef = ref !== undefined && ctx.g.enums.has(ref);
          const hasInline = inline !== undefined && inline.length > 0;
          if (hasRef || hasInline) continue;
          push(`枚举字段「${loc.field.name}」没有声明取值范围`, { fieldId, nodeId: loc.ownerNodeId }, {
            kind: 'addEnumValues',
            fieldId,
          });
        }
      });
    },
  },

  {
    id: 'L009',
    title: '自引用外键无深度上限',
    defaultSeverity: 'info',
    description: '树形结构递归查询没有深度上限时，生成的分页接口可能一次拉穿整棵树。',
    run(ctx) {
      return collect(ctx, this, (push) => {
        for (const table of ctx.g.tables) {
          for (const field of table.table.fields) {
            if (field.type !== 'ref') continue;
            if (field.constraints?.ref?.tableId !== table.id) continue;
            push(
              `表「${table.name}」的字段「${field.name}」是自引用外键，递归查询请声明深度上限`,
              { nodeId: table.id, fieldId: field.id },
            );
          }
        }
      });
    },
  },

  {
    id: 'L010',
    title: '命名不符合规范',
    defaultSeverity: 'warn',
    description: '表名 snake_case、字段 camelCase、接口路径 kebab-case；不统一会让生成的代码风格割裂。',
    run(ctx) {
      return collect(ctx, this, (push) => {
        for (const table of ctx.g.tables) {
          const dbName = table.table.dbName;
          if (!/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/.test(dbName)) {
            push(`表名「${dbName}」应为 snake_case`, { nodeId: table.id }, {
              kind: 'renameNode',
              nodeId: table.id,
              from: dbName,
              to: toSnakeSafe(dbName),
            });
          }
          for (const field of table.table.fields) {
            if (field.name !== 'id' && !/^[a-z][A-Za-z0-9]*$/.test(field.name)) {
              push(`字段「${field.name}」应为 camelCase`, { nodeId: table.id, fieldId: field.id }, {
                kind: 'renameField',
                fieldId: field.id,
                from: field.name,
                to: toCamelCase(field.name),
              });
            }
          }
        }

        for (const api of ctx.g.apis) {
          const path = api.api.path;
          if (path.length === 0 || !path.startsWith('/')) {
            push(`接口「${api.name}」的路径「${path}」应以 / 开头`, { nodeId: api.id });
            continue;
          }
          const bad = path.split('/').find((seg) => seg.length > 0 && !seg.startsWith('{') && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(seg));
          if (bad !== undefined) {
            push(`接口路径「${path}」的片段「${bad}」应为 kebab-case`, { nodeId: api.id });
          }
        }
      });
    },
  },

  {
    id: 'L011',
    title: '路径参数未声明对应字段',
    defaultSeverity: 'error',
    description: '`/devices/{id}` 需要在接口里声明名为 id 的路径参数，否则生成的路由取不到值。',
    run(ctx) {
      return collect(ctx, this, (push) => {
        for (const api of ctx.g.apis) {
          const declared = new Map(api.api.pathParams.map((f) => [f.name, f.id]));
          for (const name of pathParamsOf(api.api.path)) {
            if (!declared.has(name)) {
              push(`接口「${api.name}」的路径参数 {${name}} 没有声明对应字段`, {
                nodeId: api.id,
              });
            }
          }
          for (const [name, fieldId] of declared) {
            if (!pathParamsOf(api.api.path).includes(name)) {
              push(`接口「${api.name}」声明了路径参数「${name}」，但路径里没有 {${name}}`, {
                nodeId: api.id,
                fieldId,
              });
            }
          }
        }
      });
    },
  },

  {
    id: 'L012',
    title: '页面路由重复',
    defaultSeverity: 'error',
    description: '两个页面抢同一个路由，生成的路由表里后者会覆盖前者。',
    run(ctx) {
      return collect(ctx, this, (push) => {
        const seen = new Map<string, string>();
        for (const page of ctx.g.pages) {
          const route = page.page.route;
          const first = seen.get(route);
          if (first !== undefined) {
            push(`页面「${page.name}」的路由「${route}」已被「${ctx.g.nodes.get(first)?.name ?? first}」占用`, {
              nodeId: page.id,
              pageId: page.id,
            }, {
              kind: 'setRoute',
              pageId: page.id,
              from: route,
              to: `${route.replace(/\/$/, '')}-2`,
            });
          } else {
            seen.set(route, page.id);
          }
        }
      });
    },
  },

  {
    id: 'L013',
    title: '契约要求认证但项目未启用认证',
    defaultSeverity: 'warn',
    description:
      '接口声明了 auth=bearer，但项目设置了 backend.auth=none。契约会告诉调用方要带 token，生成的代码却不会校验——' +
      '这类不一致在联调时才暴露，成本最高。',
    run(ctx) {
      return collect(ctx, this, (push) => {
        if (ctx.ir.settings.backend.auth !== 'none') return;
        for (const api of ctx.g.apis) {
          if (api.api.auth === 'none') continue;
          push(
            `接口「${api.name}」要求 ${api.api.auth} 认证，但项目设置 backend.auth = none（生成的代码不会校验 token）`,
            { nodeId: api.id },
          );
        }
      });
    },
  },

  {
    id: 'L014',
    title: '组件绑定的字段不在接口 DTO 中',
    defaultSeverity: 'warn',
    description: '字段改名或接口换了 DTO 之后，页面还绑着旧字段，生成的表单会提交一个后端不认识的属性。',
    run(ctx) {
      return collect(ctx, this, (push) => {
        for (const page of ctx.g.pages) {
          for (const component of page.page.components) {
            for (const { fieldRef, apiNodeId } of bindingsWithApi(ctx, component)) {
              if (apiNodeId === undefined) continue;
              const request = requestFieldIds(ctx.g, apiNodeId);
              const response = responseFieldIds(ctx.g, apiNodeId);
              const loc = ctx.g.fields.get(fieldRef);
              // 字段已被删除、binding 仍残留：这正是「改名后常见残留」最典型的样子，
              // 必须报出来。原实现查不到就跳过，等于放过了最该抓的情况。
              if (loc === undefined) {
                push(
                  `页面「${page.name}」的组件「${component.title ?? component.id}」绑定了已不存在的字段 ${fieldRef}`,
                  { nodeId: page.id, pageId: page.id, componentId: component.id, fieldId: fieldRef },
                );
                continue;
              }
              // 同一个字段 ID 在另一张表里的同名字段也算命中（字段是全局实体，实例可能复用）
              const byName = findFieldIdByName(ctx, apiNodeId, loc.field.name);
              if (request.has(fieldRef) || response.has(fieldRef)) continue;
              if (byName !== undefined) continue;
              push(
                `页面「${page.name}」的组件「${component.title ?? component.id}」绑定的字段「${loc.field.name}」不在接口 DTO 中`,
                { nodeId: page.id, pageId: page.id, componentId: component.id, fieldId: fieldRef },
              );
            }
          }
        }
      });
    },
  },
];

/** 组件 → (绑定的字段 ID, 该组件用的接口节点 ID) */
function bindingsWithApi(
  ctx: LintContext,
  component: PageComponent,
): Array<{ fieldRef: string; apiNodeId: string | undefined }> {
  const out: Array<{ fieldRef: string; apiNodeId: string | undefined }> = [];
  const apiRef: string | undefined =
    component.type === 'searchForm' || component.type === 'table' || component.type === 'form' || component.type === 'detail'
      ? component.apiRef
      : component.type === 'action'
        ? component.apiRef
        : undefined;

  for (const binding of component.bindings) {
    out.push({ fieldRef: binding.fieldRef, apiNodeId: apiRef });
  }

  if (component.type === 'table') {
    for (const col of component.columns) out.push({ fieldRef: col.fieldRef, apiNodeId: apiRef });
  }

  void ctx;
  return out;
}

/** 在接口的请求/响应字段里按名字找字段 ID（用于「同名字段换 ID 也算命中」） */
function findFieldIdByName(ctx: LintContext, apiNodeId: string, name: string): string | undefined {
  const node = ctx.g.nodes.get(apiNodeId);
  if (node === undefined || node.kind !== 'api') return undefined;
  for (const list of [node.api.pathParams, node.api.query, node.api.headers]) {
    const hit = list.find((f) => f.name === name);
    if (hit !== undefined) return hit.id;
  }
  const bodyHit = node.api.requestBody?.fields.find((f) => f.name === name);
  if (bodyHit !== undefined) return bodyHit.id;
  for (const response of node.api.responses) {
    const hit = response.fields.find((f) => f.name === name);
    if (hit !== undefined) return hit.id;
  }
  return undefined;
}

/** 类型兼容判定：数字 ↔ 字符串算不兼容（需要转换函数），整数 ↔ 数字算兼容 */
function compatible(source: string, target: string): boolean {
  if (source === target) return true;
  const numeric = new Set(['number', 'integer']);
  if (numeric.has(source) && numeric.has(target)) return true;
  const textual = new Set(['string', 'text']);
  if (textual.has(source) && textual.has(target)) return true;
  // ref 与 string/integer 兼容：外键在 JSON 里就是标量
  if (source === 'ref' && (target === 'string' || target === 'integer' || target === 'number')) return true;
  if (target === 'ref' && (source === 'string' || source === 'integer' || source === 'number')) return true;
  if (source === 'date' || source === 'datetime') return target === 'string' || target === 'datetime' || target === 'date';
  if (target === 'date' || target === 'datetime') return source === 'string' || source === 'datetime' || source === 'date';
  return false;
}

/** 命名修正用的宽松 snake_case（不保证唯一，修复前需要去重） */
function toSnakeSafe(input: string): string {
  return toCamelCase(input)
    .replace(/([A-Z])/g, '_$1')
    .toLowerCase()
    .replace(/^_+/, '');
}

// ────────────────────────────── 执行 ──────────────────────────────

const DEFAULT_OVERRIDES: Record<string, LintSeverity | 'off'> = {
  // 示例值由编译期注入，这条规则默认不启用（见 L004 注释）
  L004: 'off',
};

/**
 * IR 里持久化的忽略项是 `{ ruleId, targetId, reason }`——只记一个目标 ID，不记「目标是哪种 ID」。
 * 这是对的：忽略项要写进 IR 并长期存活，多存字段只会让旧 IR 迁移更麻烦。
 * 匹配时按「这个 ID 出现在 issue 目标的哪个字段里」判断。
 */
function ignoreMatchesTarget(ignore: { ruleId: string; targetId: string }, target: LintTarget): boolean {
  if (ignore.ruleId !== '*' && ignore.ruleId.length === 0) return false;
  return (
    target.nodeId === ignore.targetId ||
    target.fieldId === ignore.targetId ||
    target.edgeId === ignore.targetId ||
    target.componentId === ignore.targetId ||
    target.pageId === ignore.targetId
  );
}

function targetKey(target: LintTarget): string {
  return [target.nodeId, target.fieldId, target.edgeId, target.componentId, target.pageId]
    .map((v) => v ?? '')
    .join('|');
}

export function runLint(ir: IR, options: LintOptions = {}): LintResult {
  const g = buildGraphIndex(ir);
  const settings = ir.settings.lint;

  const overrides: Record<string, LintSeverity | 'off'> = {
    ...DEFAULT_OVERRIDES,
    ...(settings.enabled ? settings.ruleOverrides : {}),
    ...(options.overrides ?? {}),
  };

  const ignores = [...(settings.ignores ?? []), ...(options.ignores ?? [])];

  const ctx: LintContext = {
    ir,
    g,
    report(rule, message, target, fix) {
      const severity = (overrides[rule.id] ?? rule.defaultSeverity) as LintSeverity;
      return { ruleId: rule.id, severity, message, target, ...(fix !== undefined ? { fix } : {}) };
    },
  };

  const issues: LintIssue[] = [];
  const ignored: LintIssue[] = [];

  for (const rule of RULES) {
    if (options.only !== undefined && !options.only.includes(rule.id)) continue;
    if (options.except !== undefined && options.except.includes(rule.id)) continue;
    if (overrides[rule.id] === 'off') continue;

    let produced: LintIssue[] = [];
    try {
      produced = rule.run(ctx);
    } catch (err) {
      // 单条规则内部异常不能拖垮整个 Lint：报出来但继续跑其他规则
      issues.push({
        ruleId: rule.id,
        severity: 'error',
        message: `规则执行异常：${err instanceof Error ? err.message : String(err)}`,
        target: {},
      });
      continue;
    }

    for (const issue of produced) {
      const hit = ignores.find(
        (i) => i.ruleId === issue.ruleId && ignoreMatchesTarget(i, issue.target),
      );
      if (hit !== undefined) {
        ignored.push(issue);
      } else {
        issues.push(issue);
      }
    }
  }

  // 排序：error → warn → info，同级按规则号，再按目标，保证输出稳定
  const order: Record<LintSeverity, number> = { error: 0, warn: 1, info: 2 };
  issues.sort((a, b) => {
    if (a.severity !== b.severity) return order[a.severity] - order[b.severity];
    if (a.ruleId !== b.ruleId) return a.ruleId < b.ruleId ? -1 : 1;
    return targetKey(a.target) < targetKey(b.target) ? -1 : 1;
  });

  const stats = { error: 0, warn: 0, info: 0 };
  for (const issue of issues) stats[issue.severity] += 1;

  return {
    issues,
    ignored,
    stats,
    blocked: stats.error > 0 && settings.blockOnError,
  };
}

/** 供面板分组的聚合视图 */
export function groupByTarget(result: LintResult): Map<string, LintIssue[]> {
  const map = new Map<string, LintIssue[]>();
  for (const issue of result.issues) {
    const key = issue.target.nodeId ?? issue.target.pageId ?? '(全局)';
    const list = map.get(key);
    if (list === undefined) map.set(key, [issue]);
    else list.push(issue);
  }
  return map;
}

/** 供 CLI / CI 输出的 SARIF 简化版（GitHub Code Scanning 可直接消费） */
export function toSarif(result: LintResult): Record<string, unknown> {
  const levelOf = (s: LintSeverity): string => (s === 'error' ? 'error' : s === 'warn' ? 'warning' : 'note');
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'fsdt-lint',
            informationUri: 'https://github.com/salenju/full-stack-design-tool',
            rules: RULES.map((r) => ({ id: r.id, name: r.title, shortDescription: { text: r.description } })),
          },
        },
        results: result.issues.map((issue) => ({
          ruleId: issue.ruleId,
          level: levelOf(issue.severity),
          message: { text: issue.message },
          properties: { target: issue.target },
          ...(issue.target.nodeId !== undefined
            ? { locations: [{ logicalLocations: [{ fullyQualifiedName: issue.target.nodeId, kind: 'node' }] }] }
            : {}),
        })),
      },
    ],
  };
}

export { RULES as LINT_RULES };
export { pathParamsOf };
