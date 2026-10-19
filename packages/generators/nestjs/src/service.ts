/**
 * NestJS service 骨架。
 *
 * 只生成**签名 + 显式未实现**，不生成任何推测性实现：
 * - 返回 `[]` 或 `{}` 会让用户以为打通了，直到联调才发现数据是假的；
 * - `throw new NotImplementedException('listDevices')` 让「没写」这件事在第一次调用时
 *   就暴露出来，且异常信息里直接给出方法名，指向明确。
 *
 * 这是 TD 7.3 的既定决策，不是偷懒。
 */

import { type ApiNode } from '@fsdt/core-ir';
import { Writer } from '@fsdt/generators-runtime';
import {
  dtoClassOf,
  queryDtoFileOf,
  requestDtoFileOf,
  responseFileOf,
  serviceClassOf,
  serviceVarOf,
  type ResourceGroup,
} from './resource.js';
import { responseModelOf, responseTsTypeOf } from './response.js';
import type { TypeCtx } from './type-map.js';

export interface ServiceOptions {
  operationIdOf: Map<string, string>;
  irHash: string;
}

function signatureOf(
  ctx: TypeCtx,
  api: ApiNode,
  operationId: string,
): { params: string[]; returnType: string } {
  const params: string[] = [];
  for (const field of api.api.pathParams) params.push(`${field.name}: string`);
  if (api.api.query.length > 0) params.push(`query: ${dtoClassOf(operationId, 'QueryDto')}`);
  if (api.api.requestBody !== undefined && api.api.requestBody.shape === 'object') {
    params.push(`body: ${dtoClassOf(operationId, 'Dto')}`);
  }
  const model = responseModelOf(operationId, api);
  void ctx;
  return { params, returnType: responseTsTypeOf(model) };
}

export function renderService(ctx: TypeCtx, group: ResourceGroup, options: ServiceOptions): string {
  const w = new Writer();
  const className = serviceClassOf(group);
  const prisma = 'prisma';

  w.line(
    `// @dsg:generated file=src/modules/${group.dir}/${group.dir}.service.ts node=${group.apis.map((a) => a.id).join(',')} ir=${options.irHash} generator=nestjs@0.1.0`,
  );
  w.line("import { Injectable, NotImplementedException } from '@nestjs/common';");
  w.line("import { PrismaService } from '../../prisma/prisma.service';");

  // DTO 与响应类只作为**类型**出现在签名里，用 import type 避免运行时循环依赖
  const typeImports = new Map<string, string[]>();
  const addType = (file: string, name: string): void => {
    const list = typeImports.get(file) ?? [];
    if (!list.includes(name)) list.push(name);
    typeImports.set(file, list);
  };
  for (const api of group.apis) {
    const operationId = options.operationIdOf.get(api.id);
    if (operationId === undefined) continue;
    if (api.api.query.length > 0) addType(queryDtoFileOf(operationId), dtoClassOf(operationId, 'QueryDto'));
    if (api.api.requestBody !== undefined && api.api.requestBody.shape === 'object') {
      addType(requestDtoFileOf(operationId), dtoClassOf(operationId, 'Dto'));
    }
    const model = responseModelOf(operationId, api);
    if (model.kind === 'item' || model.kind === 'itemArray') addType(responseFileOf(operationId), model.className);
    if (model.kind === 'page') addType(responseFileOf(operationId), model.className);
  }
  for (const [file, names] of [...typeImports.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    w.line(`import type { ${names.sort().join(', ')} } from '${file}';`);
  }
  w.blank();

  w.line('@Injectable()');
  w.line(`export class ${className} {`);
  w.line(`  constructor(private readonly ${prisma}: PrismaService) {}`);

  for (const api of group.apis) {
    const operationId = options.operationIdOf.get(api.id);
    if (operationId === undefined) continue;
    const { params, returnType } = signatureOf(ctx, api, operationId);
    w.blank();
    w.line(`  async ${operationId}(${params.join(', ')}): Promise<${returnType}> {`);
    const hint = hintOf(api);
    w.line(`    // @dsg:todo 实现 ${operationId}：${hint}`);
    w.line(`    throw new NotImplementedException('${operationId}');`);
    w.line('  }');
  }

  w.line('}');
  void serviceVarOf;
  return w.toString();
}

/** 给 @dsg:todo 补一句「该写什么」，比只写方法名有用得多 */
function hintOf(api: ApiNode): string {
  const method = api.api.method;
  const table = api.api.tags[0] ?? '目标表';
  if (method === 'GET' && api.api.pathParams.length === 0) {
    return `分页查询 ${table}，使用 query.page/query.pageSize 与筛选条件`;
  }
  if (method === 'GET') return `按主键查询单条 ${table}，未找到时抛 NotFoundException`;
  if (method === 'POST') return `创建 ${table}，写库前做业务校验`;
  if (method === 'PUT' || method === 'PATCH') return `更新 ${table}，注意只更新传入的字段`;
  if (method === 'DELETE') return `删除 ${table}，考虑软删除（deletedAt）`;
  return `实现 ${method} ${api.api.path}`;
}
