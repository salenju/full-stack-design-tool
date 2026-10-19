/**
 * operationId 分配（单一真相源）。
 *
 * 为什么单独抽出来：OpenAPI 的 `operationId`、UI Schema 的 `dataSources[].operationId`、
 * Spring/NestJS 的控制器方法名、前端生成的 API 函数名，**必须指同一个字符串**。
 * 如果两处各自算一遍，用户改个 codeName 就会变成「契约里叫 listDevices2、
 * 前端生成器去找 listDevices」——编译能过，运行时 404。
 *
 * 规则：
 * - 基名取 `codeName`（转 camelCase），为空时退化到 `name`；
 * - 重复时加数字后缀（`listDevices2`），并记 warning 指向冲突的两个节点；
 * - 排序固定为「路径字典序 + 方法字典序」，保证同一 IR 每次分配结果一致。
 */

import { toCamelCase, type IR } from '@fsdt/core-ir';

export interface OperationIdAllocation {
  /** 接口节点 ID → operationId */
  byNodeId: Map<string, string>;
  /** operationId → 接口节点 ID */
  byOperationId: Map<string, string>;
  /** 冲突提示（非阻断） */
  warnings: string[];
}

export function allocateOperationIds(ir: IR): OperationIdAllocation {
  const byNodeId = new Map<string, string>();
  const byOperationId = new Map<string, string>();
  const warnings: string[] = [];

  // 只遍历接口节点；这里不依赖 GraphIndex，避免与 compile 阶段的索引构建顺序耦合
  const apis = ir.nodes
    .filter((n) => n.kind === 'api')
    .slice()
    .sort((a, b) => {
      const ap = a.kind === 'api' ? a.api.path : '';
      const bp = b.kind === 'api' ? b.api.path : '';
      if (ap !== bp) return ap < bp ? -1 : 1;
      const am = a.kind === 'api' ? a.api.method : '';
      const bm = b.kind === 'api' ? b.api.method : '';
      return am < bm ? -1 : am > bm ? 1 : 0;
    });

  for (const node of apis) {
    if (node.kind !== 'api') continue;

    const base = node.codeName.length > 0 ? toCamelCase(node.codeName) : toCamelCase(node.name) || 'operation';
    let candidate = base;
    let i = 1;
    while (byOperationId.has(candidate)) {
      i += 1;
      candidate = `${base}${i}`;
    }
    if (i > 1) {
      warnings.push(
        `operationId「${base}」重复（节点 ${byOperationId.get(base)} 与 ${node.id}），` +
          `后者已改名为「${candidate}」，建议在画布上重命名其一`,
      );
    }
    byNodeId.set(node.id, candidate);
    byOperationId.set(candidate, node.id);
  }

  return { byNodeId, byOperationId, warnings };
}
