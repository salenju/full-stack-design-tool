/**
 * IR 图索引与便捷查询。
 *
 * 为什么不在 UI 里直接 `ir.nodes.find(...)`：
 * - 字段是第一等实体，页面组件用 `fieldRef` 指向它，UI 需要「给我这个字段」的 O(1) 查询；
 * - Lint 需要「这个字段被哪些接口/页面引用」的反向索引，否则每次全量扫描会卡；
 * - 编译器需要稳定排序（表按 dbName、接口按 path）来保证产物字节级可复现。
 */

import type {
  ApiNode,
  EnumDef,
  Field,
  IR,
  IREdge,
  IRNode,
  ModelDef,
  PageComponent,
  PageNode,
  TableNode,
} from './types.js';

export interface FieldLocation {
  field: Field;
  /** 字段所属节点 */
  ownerNodeId: string;
  /** 字段在接口节点中的分区，表字段为 undefined */
  partition?: 'pathParams' | 'query' | 'headers' | 'body' | 'response';
  /** 响应分区时的状态码 */
  responseStatus?: number;
}

export interface ComponentLocation {
  component: PageComponent;
  pageNodeId: string;
}

export interface GraphIndex {
  nodes: Map<string, IRNode>;
  tables: TableNode[];
  apis: ApiNode[];
  pages: PageNode[];
  notes: IRNode[];

  /** fieldId → 字段及其归属 */
  fields: Map<string, FieldLocation>;
  /** 节点 ID → 该节点持有的全部字段 ID（按节点内顺序） */
  nodeFieldIds: Map<string, string[]>;
  /** componentId → 组件及所属页面 */
  components: Map<string, ComponentLocation>;
  enums: Map<string, EnumDef>;
  models: Map<string, ModelDef>;

  /** 节点 ID → 相邻连线（入 + 出） */
  edgesByNode: Map<string, IREdge[]>;
  /** 接口节点 ID → 响应字段 ID（按状态码与顺序） */
  apiResponseFieldIds: Map<string, string[]>;
  /** 表节点 ID → 其主键字段（缺失时为 undefined） */
  primaryKey: Map<string, Field | undefined>;
}

const EMPTY: string[] = [];

export function buildGraphIndex(ir: IR): GraphIndex {
  const nodes = new Map<string, IRNode>();
  const tables: TableNode[] = [];
  const apis: ApiNode[] = [];
  const pages: PageNode[] = [];
  const notes: IRNode[] = [];
  const fields = new Map<string, FieldLocation>();
  const nodeFieldIds = new Map<string, string[]>();
  const components = new Map<string, ComponentLocation>();
  const edgesByNode = new Map<string, IREdge[]>();
  const apiResponseFieldIds = new Map<string, string[]>();
  const primaryKey = new Map<string, Field | undefined>();

  const registerFields = (nodeId: string, list: Field[], partition?: FieldLocation['partition'], status?: number): void => {
    const ids = nodeFieldIds.get(nodeId) ?? [];
    for (const field of list) {
      const location: FieldLocation = { field, ownerNodeId: nodeId };
      if (partition !== undefined) location.partition = partition;
      if (status !== undefined) location.responseStatus = status;
      fields.set(field.id, location);
      ids.push(field.id);
    }
    nodeFieldIds.set(nodeId, ids);
  };

  for (const node of ir.nodes) {
    nodes.set(node.id, node);
    switch (node.kind) {
      case 'table': {
        tables.push(node);
        registerFields(node.id, node.table.fields, undefined, undefined);
        const pk =
          node.table.fields.find((f) => f.name === 'id' && f.required) ??
          (() => {
            const uniqueIdx = node.table.indexes.find((i) => i.unique && i.fieldIds.length === 1);
            const pkId = uniqueIdx?.fieldIds[0];
            return pkId === undefined ? undefined : node.table.fields.find((f) => f.id === pkId);
          })();
        primaryKey.set(node.id, pk);
        break;
      }
      case 'api': {
        apis.push(node);
        registerFields(node.id, node.api.pathParams, 'pathParams', undefined);
        registerFields(node.id, node.api.query, 'query', undefined);
        registerFields(node.id, node.api.headers, 'headers', undefined);
        if (node.api.requestBody !== undefined) {
          registerFields(node.id, node.api.requestBody.fields, 'body', undefined);
        }
        const responseIds: string[] = [];
        for (const resp of node.api.responses) {
          registerFields(node.id, resp.fields, 'response', resp.status);
          for (const f of resp.fields) responseIds.push(f.id);
        }
        apiResponseFieldIds.set(node.id, responseIds);
        break;
      }
      case 'page': {
        pages.push(node);
        for (const c of node.page.components) {
          components.set(c.id, { component: c, pageNodeId: node.id });
        }
        break;
      }
      case 'note':
        notes.push(node);
        break;
    }
  }

  for (const edge of ir.edges) {
    for (const end of [edge.source, edge.target]) {
      const list = edgesByNode.get(end.nodeId);
      if (list === undefined) edgesByNode.set(end.nodeId, [edge]);
      else if (!list.includes(edge)) list.push(edge);
    }
  }

  return {
    nodes,
    tables,
    apis,
    pages,
    notes,
    fields,
    nodeFieldIds,
    components,
    edgesByNode,
    apiResponseFieldIds,
    primaryKey,
    enums: new Map(ir.dictionaries.enums.map((e) => [e.id, e])),
    models: new Map(ir.dictionaries.models.map((m) => [m.id, m])),
  };
}

export function getNode(ir: IR, nodeId: string): IRNode | undefined {
  return ir.nodes.find((n) => n.id === nodeId);
}

export function getTable(ir: IR, nodeId: string): TableNode | undefined {
  const n = getNode(ir, nodeId);
  return n?.kind === 'table' ? n : undefined;
}

export function getApi(ir: IR, nodeId: string): ApiNode | undefined {
  const n = getNode(ir, nodeId);
  return n?.kind === 'api' ? n : undefined;
}

export function getPage(ir: IR, nodeId: string): PageNode | undefined {
  const n = getNode(ir, nodeId);
  return n?.kind === 'page' ? n : undefined;
}

export function getField(ir: IR, fieldId: string): Field | undefined {
  for (const node of ir.nodes) {
    switch (node.kind) {
      case 'table': {
        const f = node.table.fields.find((x) => x.id === fieldId);
        if (f !== undefined) return f;
        break;
      }
      case 'api': {
        const candidates: Array<Field | undefined> = [
          ...node.api.pathParams,
          ...node.api.query,
          ...node.api.headers,
          ...(node.api.requestBody?.fields ?? []),
          ...node.api.responses.flatMap((r) => r.fields),
        ];
        const hit = candidates.find((x) => x?.id === fieldId);
        if (hit !== undefined) return hit;
        break;
      }
      case 'page':
      case 'note':
        break;
    }
  }
  return undefined;
}

/** 字段所属节点（找不到返回 undefined） */
export function getFieldOwner(ir: IR, fieldId: string): IRNode | undefined {
  for (const node of ir.nodes) {
    if (nodeFieldIdsOf(ir, node).includes(fieldId)) return node;
  }
  return undefined;
}

export function nodeFieldIdsOf(ir: IR, node: IRNode): string[] {
  switch (node.kind) {
    case 'table':
      return node.table.fields.map((f) => f.id);
    case 'api':
      return [
        ...node.api.pathParams.map((f) => f.id),
        ...node.api.query.map((f) => f.id),
        ...node.api.headers.map((f) => f.id),
        ...(node.api.requestBody?.fields.map((f) => f.id) ?? []),
        ...node.api.responses.flatMap((r) => r.fields.map((f) => f.id)),
      ];
    default:
      return EMPTY;
  }
}

/** 按 dbName 排序的表节点（保证产物可复现） */
export function sortedTables(ir: IR): TableNode[] {
  return ir.nodes.filter((n): n is TableNode => n.kind === 'table').sort((a, b) => cmp(a.table.dbName, b.table.dbName));
}

/** 按 path + method 排序的接口节点（保证产物可复现） */
export function sortedApis(ir: IR): ApiNode[] {
  return ir.nodes
    .filter((n): n is ApiNode => n.kind === 'api')
    .sort((a, b) => cmp(a.api.path, b.api.path) || cmp(a.api.method, b.api.method));
}

/** 按 route 排序的页面节点 */
export function sortedPages(ir: IR): PageNode[] {
  return ir.nodes.filter((n): n is PageNode => n.kind === 'page').sort((a, b) => cmp(a.page.route, b.page.route));
}

/** 按 codeName 排序的枚举（保证产物可复现） */
export function sortedEnums(ir: IR): EnumDef[] {
  return [...ir.dictionaries.enums].sort((a, b) => cmp(a.name, b.name));
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 取某节点的所有出边（source 是该节点） */
export function outgoingEdges(ir: IR, nodeId: string, kind?: IREdge['kind']): IREdge[] {
  return ir.edges.filter((e) => e.source.nodeId === nodeId && (kind === undefined || e.kind === kind));
}

/** 取某节点的所有入边（target 是该节点） */
export function incomingEdges(ir: IR, nodeId: string, kind?: IREdge['kind']): IREdge[] {
  return ir.edges.filter((e) => e.target.nodeId === nodeId && (kind === undefined || e.kind === kind));
}

/**
 * 从页面沿 call → read/write 边做 BFS，得到「流程闭包」。
 * 供 AI 上下文分片与 UI Schema 数据源推导使用（技术设计 6.5）。
 */
export interface ReachableSubgraph {
  pageIds: string[];
  apiIds: string[];
  tableIds: string[];
  fieldIds: string[];
}

export function reachableFromPage(ir: IR, rootPageId: string): ReachableSubgraph {
  const pageIds = new Set<string>([rootPageId]);
  const apiIds = new Set<string>();
  const tableIds = new Set<string>();
  const fieldIds = new Set<string>();

  const queue: string[] = [rootPageId];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (visited.has(current)) continue;
    visited.add(current);

    for (const edge of ir.edges) {
      if (edge.source.nodeId !== current) continue;
      if (edge.kind === 'navigate') {
        if (!pageIds.has(edge.target.nodeId)) {
          pageIds.add(edge.target.nodeId);
          queue.push(edge.target.nodeId);
        }
        continue;
      }
      if (edge.kind === 'call' || edge.kind === 'read' || edge.kind === 'write' || edge.kind === 'map') {
        const target = ir.nodes.find((n) => n.id === edge.target.nodeId);
        if (target === undefined) continue;
        if (target.kind === 'api') {
          apiIds.add(target.id);
          queue.push(target.id);
        } else if (target.kind === 'table') {
          tableIds.add(target.id);
        }
      }
      if (edge.source.fieldId !== undefined) fieldIds.add(edge.source.fieldId);
      if (edge.target.fieldId !== undefined) fieldIds.add(edge.target.fieldId);
    }
  }

  // 接口用到的表（沿 write 边）
  for (const apiId of apiIds) {
    for (const edge of ir.edges) {
      if (edge.source.nodeId !== apiId) continue;
      const target = ir.nodes.find((n) => n.id === edge.target.nodeId);
      if (target?.kind === 'table') tableIds.add(target.id);
    }
  }

  return {
    pageIds: [...pageIds],
    apiIds: [...apiIds],
    tableIds: [...tableIds],
    fieldIds: [...fieldIds],
  };
}
