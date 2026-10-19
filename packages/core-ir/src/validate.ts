/**
 * IR 语义校验（schema 之外的检查）。
 *
 * 分工：
 * - **schema.ts** 管「形状」：类型对不对、必填在不在、正则匹不匹配。
 * - **本文件** 管「语义」：引用是否存在、ID 是否唯一、枚举引用是否可解析、连线两端是否合法。
 *
 * 之所以拆开：形状错误通常一次改好；语义错误会随着编辑不断产生（删了字段但连线还在），
 * 需要在每次保存前后快速跑、并按 ID 精确定位。
 */

import { IRValidationError, type Diagnostic } from './diagnostics.js';
import type {
  ApiNode,
  EdgeKind,
  Field,
  IR,
  IREdge,
  IRNode,
  PageComponent,
  PageNode,
  TableNode,
} from './types.js';

interface Index {
  nodes: Map<string, IRNode>;
  tables: Map<string, TableNode>;
  apis: Map<string, ApiNode>;
  pages: Map<string, PageNode>;
  /** 全局字段索引：fieldId → { field, ownerNodeId } */
  fields: Map<string, { field: Field; ownerNodeId: string }>;
  components: Map<string, { component: PageComponent; pageNodeId: string }>;
  canvases: Set<string>;
  enums: Set<string>;
  models: Set<string>;
}

export function buildIndex(ir: IR): Index {
  const nodes = new Map<string, IRNode>();
  const tables = new Map<string, TableNode>();
  const apis = new Map<string, ApiNode>();
  const pages = new Map<string, PageNode>();
  const fields = new Map<string, { field: Field; ownerNodeId: string }>();
  const components = new Map<string, { component: PageComponent; pageNodeId: string }>();

  for (const node of ir.nodes) {
    nodes.set(node.id, node);
    switch (node.kind) {
      case 'table':
        tables.set(node.id, node);
        for (const f of node.table.fields) fields.set(f.id, { field: f, ownerNodeId: node.id });
        break;
      case 'api':
        apis.set(node.id, node);
        for (const f of node.api.pathParams) fields.set(f.id, { field: f, ownerNodeId: node.id });
        for (const f of node.api.query) fields.set(f.id, { field: f, ownerNodeId: node.id });
        for (const f of node.api.headers) fields.set(f.id, { field: f, ownerNodeId: node.id });
        if (node.api.requestBody) {
          for (const f of node.api.requestBody.fields) fields.set(f.id, { field: f, ownerNodeId: node.id });
        }
        for (const r of node.api.responses) {
          for (const f of r.fields) fields.set(f.id, { field: f, ownerNodeId: node.id });
        }
        break;
      case 'page':
        pages.set(node.id, node);
        for (const c of node.page.components) {
          components.set(c.id, { component: c, pageNodeId: node.id });
        }
        break;
      case 'note':
        break;
    }
  }

  return {
    nodes,
    tables,
    apis,
    pages,
    fields,
    components,
    canvases: new Set(ir.canvases.map((c) => c.id)),
    enums: new Set(ir.dictionaries.enums.map((e) => e.id)),
    models: new Set(ir.dictionaries.models.map((m) => m.id)),
  };
}

/** 合法连线的 source/target 节点种类 */
const EDGE_NODE_RULES: Record<EdgeKind, { source: IRNode['kind'][]; target: IRNode['kind'][] }> = {
  call: { source: ['page', 'api'], target: ['api'] },
  read: { source: ['api'], target: ['table', 'page'] },
  write: { source: ['api'], target: ['table'] },
  map: { source: ['api', 'table', 'page'], target: ['api', 'table', 'page'] },
  navigate: { source: ['page'], target: ['page'] },
};

function diag(
  code: string,
  severity: Diagnostic['severity'],
  message: string,
  target: Diagnostic['target'],
): Diagnostic {
  return { code, severity, message, target };
}

/**
 * 全量语义校验。返回诊断列表，不抛异常——调用方决定「有 error 是否中断」。
 */
export function validateIR(ir: IR): Diagnostic[] {
  const out: Diagnostic[] = [];
  const idx = buildIndex(ir);

  // ── IR001 画布引用 ──────────────────────────────────────────────
  for (const node of ir.nodes) {
    if (!idx.canvases.has(node.canvasId)) {
      out.push(
        diag('IR001', 'error', `节点「${node.name}」指向不存在的画布 ${node.canvasId}`, { nodeId: node.id }),
      );
    }
  }
  for (const edge of ir.edges) {
    if (!idx.canvases.has(edge.canvasId)) {
      out.push(diag('IR001', 'error', `连线 ${edge.id} 指向不存在的画布 ${edge.canvasId}`, { edgeId: edge.id }));
    }
  }

  // ── IR002 ID 唯一性 ─────────────────────────────────────────────
  const seen = new Map<string, string>();
  const checkUnique = (id: string, desc: string, target: Diagnostic['target']): void => {
    const prev = seen.get(id);
    if (prev !== undefined) {
      out.push(diag('IR002', 'error', `ID 重复：${id}（${desc} 与 ${prev}）`, target));
    } else {
      seen.set(id, desc);
    }
  };
  for (const node of ir.nodes) {
    checkUnique(node.id, `节点 ${node.name}`, { nodeId: node.id });
    for (const f of collectNodeFields(node)) {
      checkUnique(f.id, `字段 ${node.name}.${f.name}`, { fieldId: f.id, nodeId: node.id });
    }
    if (node.kind === 'page') {
      for (const c of node.page.components) {
        checkUnique(c.id, `组件 ${c.type}`, { componentId: c.id, nodeId: node.id });
      }
    }
  }
  for (const edge of ir.edges) checkUnique(edge.id, '连线', { edgeId: edge.id });

  // ── IR003 枚举引用 ─────────────────────────────────────────────
  for (const node of ir.nodes) {
    for (const f of collectNodeFields(node)) {
      if (f.type === 'enum') {
        const enumRef = f.constraints?.enumRef;
        const inline = f.constraints?.enumValues;
        if (enumRef !== undefined && !idx.enums.has(enumRef)) {
          out.push(
            diag('IR003', 'error', `字段「${f.name}」引用了不存在的枚举 ${enumRef}`, {
              fieldId: f.id,
              nodeId: node.id,
            }),
          );
        }
        if (enumRef === undefined && (inline === undefined || inline.length === 0)) {
          out.push(
            diag('IR003', 'error', `枚举字段「${f.name}」既未引用命名枚举，也未声明内联取值`, {
              fieldId: f.id,
              nodeId: node.id,
            }),
          );
        }
      }
    }
  }

  // ── IR004 外键目标 ─────────────────────────────────────────────
  for (const node of ir.nodes) {
    for (const f of collectNodeFields(node)) {
      if (f.type !== 'ref') continue;
      const ref = f.constraints?.ref;
      if (ref === undefined) {
        out.push(
          diag('IR004', 'error', `引用字段「${f.name}」缺少 ref 约束（不知道指向哪张表）`, {
            fieldId: f.id,
            nodeId: node.id,
          }),
        );
        continue;
      }
      const targetTable = idx.tables.get(ref.tableId);
      if (targetTable === undefined) {
        out.push(
          diag('IR004', 'error', `字段「${f.name}」引用了不存在的表 ${ref.tableId}`, {
            fieldId: f.id,
            nodeId: node.id,
          }),
        );
        continue;
      }
      if (ref.fieldId !== undefined && !targetTable.table.fields.some((x) => x.id === ref.fieldId)) {
        out.push(
          diag('IR004', 'error', `字段「${f.name}」引用的目标字段 ${ref.fieldId} 不存在`, {
            fieldId: f.id,
            nodeId: node.id,
          }),
        );
      }
    }
  }

  // ── IR005 连线两端存在 + 种类合法 ──────────────────────────────
  for (const edge of ir.edges) {
    const s = idx.nodes.get(edge.source.nodeId);
    const t = idx.nodes.get(edge.target.nodeId);
    if (s === undefined) {
      out.push(diag('IR005', 'error', `连线 ${edge.id} 的起点节点不存在`, { edgeId: edge.id }));
      continue;
    }
    if (t === undefined) {
      out.push(diag('IR005', 'error', `连线 ${edge.id} 的终点节点不存在`, { edgeId: edge.id }));
      continue;
    }
    const rule = EDGE_NODE_RULES[edge.kind];
    if (!rule.source.includes(s.kind)) {
      out.push(
        diag('IR005', 'error', `${edge.kind} 连线的起点不能是「${s.kind}」节点（${s.name}）`, {
          edgeId: edge.id,
          nodeId: s.id,
        }),
      );
    }
    if (!rule.target.includes(t.kind)) {
      out.push(
        diag('IR005', 'error', `${edge.kind} 连线的终点不能是「${t.kind}」节点（${t.name}）`, {
          edgeId: edge.id,
          nodeId: t.id,
        }),
      );
    }
    if (edge.source.fieldId !== undefined && !idx.fields.has(edge.source.fieldId)) {
      out.push(diag('IR005', 'error', `连线 ${edge.id} 的起点字段不存在`, { edgeId: edge.id }));
    }
    if (edge.target.fieldId !== undefined && !idx.fields.has(edge.target.fieldId)) {
      out.push(diag('IR005', 'error', `连线 ${edge.id} 的终点字段不存在`, { edgeId: edge.id }));
    }
    // 自连会生成无法收敛的递归（call/map 都不允许）
    if (edge.source.nodeId === edge.target.nodeId && edge.kind !== 'map') {
      out.push(
        diag('IR005', 'warn', `${edge.kind} 连线自连（${s.name}），确认是否为预期`, {
          edgeId: edge.id,
          nodeId: s.id,
        }),
      );
    }
  }

  // ── IR006 组件 → 接口引用 ─────────────────────────────────────
  for (const node of ir.nodes) {
    if (node.kind !== 'page') continue;
    for (const apiRef of collectComponentApiRefs(node)) {
      if (!idx.apis.has(apiRef.ref)) {
        out.push(
          diag('IR006', 'error', `页面「${node.name}」的 ${apiRef.where} 指向不存在的接口 ${apiRef.ref}`, {
            nodeId: node.id,
            componentId: apiRef.componentId,
          }),
        );
      }
    }
    // 组件嵌套引用（tabs / card 的 componentIds）
    const localIds = new Set(node.page.components.map((c) => c.id));
    for (const c of node.page.components) {
      const childIds =
        c.type === 'tabs' ? c.tabs.flatMap((t) => t.componentIds) : c.type === 'card' ? c.componentIds : [];
      for (const cid of childIds) {
        if (!localIds.has(cid)) {
          out.push(
            diag('IR006', 'error', `页面「${node.name}」引用了不存在的子组件 ${cid}`, {
              nodeId: node.id,
              componentId: c.id,
            }),
          );
        }
      }
    }
    // 动作组件引用的目标组件必须存在
    for (const c of node.page.components) {
      const actions = c.type === 'table' ? c.rowActions : c.type === 'action' ? [c] : [];
      for (const a of actions) {
        if (a.trigger.componentId !== undefined && !localIds.has(a.trigger.componentId)) {
          out.push(
            diag('IR006', 'error', `页面「${node.name}」的动作引用了不存在的组件 ${a.trigger.componentId}`, {
              nodeId: node.id,
              componentId: a.id,
            }),
          );
        }
        if (a.navigateTo !== undefined) {
          const target = [...idx.pages.values()].find((p) => p.page.route === a.navigateTo);
          if (target === undefined) {
            out.push(
              diag('IR006', 'error', `页面「${node.name}」的动作指向不存在的路由 ${a.navigateTo}`, {
                nodeId: node.id,
                componentId: a.id,
              }),
            );
          }
        }
      }
    }
    // 绑定字段必须存在
    for (const c of node.page.components) {
      for (const b of c.bindings) {
        if (!idx.fields.has(b.fieldRef)) {
          out.push(
            diag('IR006', 'error', `页面「${node.name}」的组件绑定了不存在的字段 ${b.fieldRef}`, {
              nodeId: node.id,
              componentId: c.id,
              fieldId: b.fieldRef,
            }),
          );
        }
      }
      if (c.type === 'table') {
        for (const col of c.columns) {
          if (!idx.fields.has(col.fieldRef)) {
            out.push(
              diag('IR006', 'error', `页面「${node.name}」的表格列绑定了不存在的字段 ${col.fieldRef}`, {
                nodeId: node.id,
                componentId: c.id,
                fieldId: col.fieldRef,
              }),
            );
          }
        }
      }
    }
  }

  // ── IR007 接口路径参数与 pathParams 一致性 ────────────────────
  for (const api of idx.apis.values()) {
    const placeholders = [...api.api.path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1] as string);
    const declared = new Set(api.api.pathParams.map((f) => f.name));
    for (const p of placeholders) {
      if (!declared.has(p)) {
        out.push(
          diag('IR007', 'error', `接口「${api.name}」的路径参数 {${p}} 未在 pathParams 中声明`, {
            nodeId: api.id,
          }),
        );
      }
    }
    for (const name of declared) {
      if (!placeholders.includes(name)) {
        out.push(
          diag('IR007', 'warn', `接口「${api.name}」声明了路径参数「${name}」但路径里没有占位符`, {
            nodeId: api.id,
          }),
        );
      }
    }
  }

  // ── IR008 接口 method+path 重复 ───────────────────────────────
  const routes = new Map<string, string>();
  for (const api of idx.apis.values()) {
    const key = `${api.api.method} ${api.api.path}`;
    const prev = routes.get(key);
    if (prev !== undefined) {
      out.push(
        diag('IR008', 'error', `接口路由重复：${key}（${prev} 与 ${api.name}）`, { nodeId: api.id }),
      );
    } else {
      routes.set(key, api.name);
    }
  }

  // ── IR009 页面路由重复 ────────────────────────────────────────
  const pageRoutes = new Map<string, string>();
  for (const page of idx.pages.values()) {
    const prev = pageRoutes.get(page.page.route);
    if (prev !== undefined) {
      out.push(
        diag('IR009', 'error', `页面路由重复：${page.page.route}（${prev} 与 ${page.name}）`, {
          nodeId: page.id,
        }),
      );
    } else {
      pageRoutes.set(page.page.route, page.name);
    }
  }

  // ── IR010 codeName 冲突（会生成同名类型/DTO）─────────────────
  const codeNames = new Map<string, string>();
  for (const node of ir.nodes) {
    if (node.kind === 'note') continue;
    if (node.kind === 'api') continue; // operationId 允许重名，OpenAPI 会以 tags 分组
    const prev = codeNames.get(node.codeName);
    if (prev !== undefined) {
      out.push(
        diag('IR010', 'error', `代码标识重复：${node.codeName}（${prev} 与 ${node.name}），会导致同名类型`, {
          nodeId: node.id,
        }),
      );
    } else {
      codeNames.set(node.codeName, node.name);
    }
  }

  // ── IR011 表缺少主键 ─────────────────────────────────────────
  for (const table of idx.tables.values()) {
    const hasPk = table.table.fields.some((f) => f.required && f.name === 'id') ||
      table.table.indexes.some((i) => i.unique && i.fieldIds.length === 1);
    if (!hasPk) {
      out.push(
        diag('IR011', 'warn', `表「${table.name}」没有主键或唯一索引，无法安全生成 CRUD 与造数`, {
          nodeId: table.id,
        }),
      );
    }
  }

  // ── IR012 敏感字段未脱敏标记却在页面显示 ─────────────────────
  for (const node of ir.nodes) {
    if (node.kind !== 'page') continue;
    for (const c of node.page.components) {
      if (c.type !== 'table') continue;
      for (const col of c.columns) {
        const entry = idx.fields.get(col.fieldRef);
        if (entry?.field.sensitive === true) {
          out.push(
            diag('IR012', 'warn', `表格列展示了敏感字段「${entry.field.name}」，确认是否需要脱敏`, {
              nodeId: node.id,
              componentId: c.id,
              fieldId: col.fieldRef,
            }),
          );
        }
      }
    }
  }

  return out;
}

function collectNodeFields(node: IRNode): Field[] {
  switch (node.kind) {
    case 'table':
      return node.table.fields;
    case 'api': {
      const out: Field[] = [...node.api.pathParams, ...node.api.query, ...node.api.headers];
      if (node.api.requestBody) out.push(...node.api.requestBody.fields);
      for (const r of node.api.responses) out.push(...r.fields);
      return out;
    }
    case 'page':
    case 'note':
      return [];
  }
}

function collectComponentApiRefs(
  page: PageNode,
): Array<{ ref: string; where: string; componentId: string }> {
  const out: Array<{ ref: string; where: string; componentId: string }> = [];
  for (const c of page.page.components) {
    switch (c.type) {
      case 'searchForm':
      case 'table':
      case 'detail':
        out.push({ ref: c.apiRef, where: `${c.type} 组件`, componentId: c.id });
        break;
      case 'form':
        out.push({ ref: c.apiRef, where: '表单提交', componentId: c.id });
        if (c.loadApiRef !== undefined) {
          out.push({ ref: c.loadApiRef, where: '表单回显', componentId: c.id });
        }
        break;
      case 'action':
        if (c.apiRef !== undefined) out.push({ ref: c.apiRef, where: '动作', componentId: c.id });
        break;
      case 'tabs':
      case 'card':
        break;
    }
    if (c.type === 'table') {
      for (const a of c.rowActions) {
        if (a.apiRef !== undefined) out.push({ ref: a.apiRef, where: '行操作', componentId: a.id });
      }
    }
  }
  return out;
}

/**
 * 断言 IR 合法：有 error 级诊断时抛 `IRValidationError`。
 * 用于 CLI 与服务的「写入前」关口。
 */
export function assertValidIR(ir: IR): void {
  const diags = validateIR(ir).filter((d) => d.severity === 'error');
  if (diags.length === 0) return;
  const detail = diags.map((d) => `  [${d.code}] ${d.message}`).join('\n');
  throw new IRValidationError(`IR 校验失败：${diags.length} 个错误\n${detail}`, diags);
}

export function getEdgeIdsOf(ir: IR, nodeId: string): IREdge[] {
  return ir.edges.filter((e) => e.source.nodeId === nodeId || e.target.nodeId === nodeId);
}
