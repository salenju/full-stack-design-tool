/**
 * NestJS 控制器渲染。
 *
 * 核心判断：**控制器是唯一「不该有业务逻辑」的层，所以它可以被完全生成**。
 * 这里刻意把每个方法都写成「取参数 → 调 service → 返回」，一行判断都没有；
 * service 里则是 `throw new NotImplementedException(...)`。
 *
 * 为什么不生成一个「看起来能跑」的 service 而是直接抛异常：
 * 返回空数组或假数据的 service 会让用户以为打通了，直到联调才发现什么都没实现；
 * 抛 NotImplementedException 是「未实现必须显式失败」。这也是 TD 7.3 的既定决策。
 */

import { toPascalCase, type ApiNode, type Field } from '@fsdt/core-ir';
import { Writer, quote } from '@fsdt/generators-runtime';
import {
  controllerClassOf,
  dtoClassOf,
  queryDtoFileOf,
  queryDtoPathOf,
  requestDtoFileOf,
  requestDtoPathOf,
  responseFileOf,
  responsePathOf,
  serviceClassOf,
  serviceVarOf,
  subPathOf,
  type ResourceGroup,
} from './resource.js';
import { apiOkResponseArgs, responseModelOf, responseTsTypeOf } from './response.js';
import type { TypeCtx } from './type-map.js';

const METHOD_DECORATOR: Record<string, string> = {
  GET: 'Get',
  POST: 'Post',
  PUT: 'Put',
  PATCH: 'Patch',
  DELETE: 'Delete',
};

/** 请求参数在控制器方法里的解构方式 */
interface ParamModel {
  /** 方法签名里的参数列表（含类型） */
  params: string[];
  /** 调用 service 时的实参列表 */
  args: string[];
  /** 需要的 @nestjs/common 装饰器 */
  decorators: Set<string>;
  /** 需要的 DTO 类名 */
  dtos: string[];
}

function paramModelOf(ctx: TypeCtx, group: ResourceGroup, api: ApiNode, operationId: string): ParamModel {
  const dtoSuffix = `${toPascalCase(operationId)}`;
  const decorators = new Set<string>();
  const params: string[] = [];
  const args: string[] = [];
  const dtos: string[] = [];

  for (const field of api.api.pathParams) {
    decorators.add('Param');
    // 单参数时直接取字符串；多参数时按名字取，避免顺序错乱
    const accessor = api.api.pathParams.length === 1 ? 'Param()' : `Param(${quote(field.name)})`;
    params.push(`@${accessor} ${field.name}: string`);
    args.push(field.name);
  }

  if (api.api.query.length > 0) {
    const queryDto = `${dtoSuffix}QueryDto`;
    dtos.push(queryDto);
    decorators.add('Query');
    params.push(`@Query() query: ${queryDto}`);
    args.push('query');
  }

  if (api.api.requestBody !== undefined && api.api.requestBody.shape === 'object') {
    const bodyDto = `${dtoSuffix}Dto`;
    dtos.push(bodyDto);
    decorators.add('Body');
    params.push(`@Body() body: ${bodyDto}`);
    args.push('body');
  }

  void group;
  return { params, args, decorators, dtos };
}

/** 查询 DTO 的字段：接口的 query 加上分页兜底（分页参数没在 IR 里声明时补默认） */
export function queryFieldsOf(api: ApiNode): Field[] {
  return api.api.query;
}

/** 需要生成的额外 DTO（请求体 / 查询），供 plan 阶段列出文件 */
export function dtoSpecsOf(api: ApiNode, operationId: string): Array<{ suffix: 'Dto' | 'QueryDto'; className: string; fields: Field[] }> {
  const out: Array<{ suffix: 'Dto' | 'QueryDto'; className: string; fields: Field[] }> = [];
  if (api.api.requestBody !== undefined && api.api.requestBody.shape === 'object') {
    out.push({
      suffix: 'Dto',
      className: dtoClassOf(operationId, 'Dto'),
      fields: api.api.requestBody.fields,
    });
  }
  if (api.api.query.length > 0) {
    out.push({
      suffix: 'QueryDto',
      className: dtoClassOf(operationId, 'QueryDto'),
      fields: api.api.query,
    });
  }
  return out;
}

export interface ControllerOptions {
  /** operationId 分配结果：节点 ID → operationId */
  operationIdOf: Map<string, string>;
  /** 接口节点 ID → 渲染好的响应类型是否为空 */
  irHash: string;
}

export function renderController(
  ctx: TypeCtx,
  group: ResourceGroup,
  options: ControllerOptions,
): string {
  const w = new Writer();
  const nodeIds = group.apis.map((a) => a.id);
  w.line(
    `// @dsg:generated file=src/modules/${group.dir}/${group.dir}.controller.ts node=${nodeIds.join(',')} ir=${options.irHash} generator=nestjs@0.1.0`,
  );

  const common = new Set<string>();
  const swagger = new Set<string>();
  const controllerImports = new Set<string>();
  const models: Array<{ api: ApiNode; operationId: string; model: ReturnType<typeof responseModelOf> }> = [];

  for (const api of group.apis) {
    const operationId = options.operationIdOf.get(api.id);
    if (operationId === undefined) continue;
    const pm = paramModelOf(ctx, group, api, operationId);
    for (const d of pm.decorators) common.add(d);
    // 方法装饰器（Get/Post/...）同样是 @nestjs/common 的导入，漏了会直接编译失败
    common.add(METHOD_DECORATOR[api.api.method] ?? 'Get');
    const model = responseModelOf(operationId, api);
    models.push({ api, operationId, model });
  }

  common.add('Controller');
  swagger.add('ApiTags');
  swagger.add('ApiOkResponse');

  w.line(`import { ${[...common].sort().join(', ')} } from '@nestjs/common';`);
  w.line(`import { ${[...swagger].sort().join(', ')} } from '@nestjs/swagger';`);
  w.line(`import { ${serviceClassOf(group)} } from './${group.dir}.service';`);

  // DTO 与响应类的导入路径统一走 resource.ts 的 helper：
  // controller 与 plan 各自拼一遍路径，必然有一处对不上。
  const importsByFile = new Map<string, string[]>();
  const addImport = (file: string, name: string): void => {
    const list = importsByFile.get(file) ?? [];
    if (!list.includes(name)) list.push(name);
    importsByFile.set(file, list);
  };
  for (const api of group.apis) {
    const operationId = options.operationIdOf.get(api.id);
    if (operationId === undefined) continue;
    for (const spec of dtoSpecsOf(api, operationId)) {
      const file = spec.suffix === 'Dto' ? requestDtoFileOf(operationId) : queryDtoFileOf(operationId);
      addImport(file, spec.className);
    }
    const model = responseModelOf(operationId, api);
    if (model.kind === 'item' || model.kind === 'itemArray') addImport(responseFileOf(operationId), model.className);
    if (model.kind === 'page') {
      addImport(responseFileOf(operationId), model.className);
      addImport(responseFileOf(operationId), model.itemClassName);
    }
  }
  for (const [file, names] of [...importsByFile.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    w.line(`import { ${names.sort().join(', ')} } from '${file}';`);
  }
  w.blank();

  w.line(`@ApiTags(${quote(group.segment)})`);
  w.line(`@Controller(${quote(group.segment)})`);
  w.line(`export class ${controllerClassOf(group)} {`);
  w.line(`  constructor(private readonly ${serviceVarOf(group)}: ${serviceClassOf(group)}) {}`);

  for (const { api, operationId, model } of models) {
    const pm = paramModelOf(ctx, group, api, operationId);
    const decorator = METHOD_DECORATOR[api.api.method] ?? 'Get';
    const sub = subPathOf(api);
    w.blank();
    // 空子路径必须写成 @Get()：@Get('') 在部分路由版本下会匹配到带斜杠的路径
    w.line(sub.length > 0 ? `  @${decorator}(${quote(sub)})` : `  @${decorator}()`);
    w.line(`  @ApiOkResponse(${apiOkResponseArgs(model)})`);
    const returnType = responseTsTypeOf(model);
    const params = pm.params.length > 0 ? pm.params.join(', ') : '';
    w.line(`  ${operationId}(${params}): Promise<${returnType}> {`);
    const args = pm.args.join(', ');
    w.line(`    return this.${serviceVarOf(group)}.${operationId}(${args});`);
    w.line('  }');
  }

  w.line('}');
  return w.toString();
}

