/**
 * 响应类型的推导与渲染。
 *
 * 为什么响应也要生成类而不是 interface：`@ApiOkResponse({ type: X })` 只接受类，
 * 传 interface 会导致 Swagger 里该接口的响应体是空的——而这正是「自动生成文档」
 * 唯一的价值所在。所以响应体也走 class + @ApiProperty。
 *
 * 信封（envelope）的处理是这里最容易错的地方：
 * IR 里「分页」不是独立形状，而是 `shape: 'array'` 加 `envelope.dataKey/totalKey`。
 * 于是「返回数组」和「返回 {items,total}」是两种完全不同的类型，生成器必须分开处理，
 * 否则前端会拿到 `res.items` 而实际上 `res` 就是数组。
 */

import { toPascalCase, type ApiNode, type Field, type ResponseDef } from '@fsdt/core-ir';
import { Writer, quote } from '@fsdt/generators-runtime';
import { isOptionalField, tsTypeOfField, type TypeCtx } from './type-map.js';

export type ResponseModel =
  | { kind: 'void' }
  | { kind: 'raw' }
  | { kind: 'item'; className: string; fields: Field[] }
  | { kind: 'itemArray'; className: string; fields: Field[] }
  | { kind: 'page'; className: string; itemClassName: string; fields: Field[]; dataKey: string; totalKey: string };

/** 取第一条 2xx 响应；没有就按 void 处理 */
export function primaryResponse(api: ApiNode): ResponseDef | undefined {
  return api.api.responses.find((r) => r.status >= 200 && r.status < 300);
}

export function responseModelOf(operationId: string, api: ApiNode): ResponseModel {
  const resp = primaryResponse(api);
  const base = toPascalCase(operationId);
  if (resp === undefined || resp.shape === 'empty' || resp.fields.length === 0) {
    if (resp?.shape === 'raw') return { kind: 'raw' };
    return { kind: 'void' };
  }
  if (resp.shape === 'raw') return { kind: 'raw' };
  if (resp.shape === 'object') {
    return { kind: 'item', className: `${base}Response`, fields: resp.fields };
  }

  // 数组形状：信封决定是数组还是分页对象
  const env = resp.envelope;
  if (env === undefined) {
    return { kind: 'itemArray', className: `${base}Item`, fields: resp.fields };
  }
  return {
    kind: 'page',
    className: `${base}Page`,
    itemClassName: `${base}Item`,
    fields: resp.fields,
    dataKey: env.dataKey,
    totalKey: env.totalKey ?? 'total',
  };
}

/** 方法签名上的返回类型（TS 源码里写的那个） */
export function responseTsTypeOf(model: ResponseModel): string {
  switch (model.kind) {
    case 'void':
      return 'void';
    case 'raw':
      return 'unknown';
    case 'item':
      return model.className;
    case 'itemArray':
      return `${model.className}[]`;
    case 'page':
      return model.className;
  }
}

function renderClass(ctx: TypeCtx, w: Writer, className: string, fields: Field[], useSwagger: boolean): void {
  w.line(`export class ${className} {`);
  // writeOnly 字段（密码、密钥）不进响应类型：类型上存在不代表真会返回，
  // 但生成器若把它写进响应类，前端就会拿到「密码字段」并开始展示它。
  for (const field of fields.filter((f) => f.writeOnly !== true)) {
    if (useSwagger) {
      const description = field.comment ?? field.description;
      const decorator =
        description !== undefined ? `@ApiProperty({ description: ${quote(description)} })` : '@ApiProperty()';
      w.line(`  ${decorator}`);
    }
    w.line(`  ${field.name}${isOptionalField(field) ? '?' : '!'}: ${tsTypeOfField(ctx, field)};`);
    w.blank();
  }
  w.line('}');
}

export interface ResponseSpec {
  className: string;
  fileName: string;
  content: string;
}

export interface RenderResponseOptions {
  /** 生成 @ApiProperty 装饰器，默认 true（与 settings.backend.swagger 一致） */
  swagger?: boolean;
}

/** 一个接口对应的响应类文件（可能一个文件里有两个类：Item + Page） */
export function renderResponseClasses(
  ctx: TypeCtx,
  operationId: string,
  api: ApiNode,
  options: RenderResponseOptions = {},
): ResponseSpec | undefined {
  const useSwagger = options.swagger ?? true;
  const model = responseModelOf(operationId, api);
  if (model.kind === 'void' || model.kind === 'raw') return undefined;

  const base = toPascalCase(operationId);
  const fileName = `${base}Response`;
  const w = new Writer();
  if (useSwagger) w.line("import { ApiProperty } from '@nestjs/swagger';");

  // 响应里出现枚举时必须显式导入：TS 里裸写 DeviceStatus 只是「以为它存在」，
  // 而 tsc 的报错会指向整个文件，不指名是哪个枚举漏了。
  const enums = new Set<string>();
  for (const field of model.kind === 'item' || model.kind === 'itemArray' || model.kind === 'page' ? model.fields : []) {
    const ref = field.constraints?.enumRef;
    if (ref === undefined) continue;
    const def = ctx.g.enums.get(ref);
    if (def !== undefined) enums.add(toPascalCase(def.name));
  }
  if (enums.size > 0) {
    w.line(`import { ${[...enums].sort().join(', ')} } from '@prisma/client';`);
  }
  w.blank();

  if (model.kind === 'item') {
    renderClass(ctx, w, model.className, model.fields, useSwagger);
  } else if (model.kind === 'itemArray') {
    renderClass(ctx, w, model.className, model.fields, useSwagger);
  } else {
    renderClass(ctx, w, model.itemClassName, model.fields, useSwagger);
    w.blank();
    w.line(`export class ${model.className} {`);
    if (useSwagger) w.line(`  @ApiProperty({ type: [${model.itemClassName}] })`);
    w.line(`  ${model.dataKey}!: ${model.itemClassName}[];`);
    w.blank();
    if (useSwagger) w.line('  @ApiProperty()');
    w.line(`  ${model.totalKey}!: number;`);
    w.line('}');
  }

  return { className: fileName, fileName, content: w.toString() };
}

/** 控制器上用到的 @ApiOkResponse 配置片段 */
export function apiOkResponseArgs(model: ResponseModel): string {
  switch (model.kind) {
    case 'void':
      return '{ description: "成功（无响应体）" }';
    case 'raw':
      return '{ description: "原始响应（非 JSON 结构）" }';
    case 'item':
      return `{ type: ${model.className} }`;
    case 'itemArray':
      return `{ type: ${model.className}, isArray: true }`;
    case 'page':
      return `{ type: ${model.className} }`;
  }
}
