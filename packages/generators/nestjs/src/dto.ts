/**
 * IR 字段 → class-validator DTO。
 *
 * 为什么 DTO 单独一个文件而不是和 controller 挤在一起：DTO 是**契约在运行时的化身**，
 * 它既被 ValidationPipe 用来拒绝非法请求，也被 Swagger 用来生成文档。用户改校验规则时
 * 只应该动这一处；塞在 controller 里会变成「改了一半，Swagger 还写着旧约束」。
 *
 * 四条映射纪律：
 * 1. **required → 去掉 `?`，不要用 `@IsOptional()`**。TypeScript 的可选性与运行时校验
 *    必须同时表达同一件事，否则会出现「类型上必填、运行时放行 undefined」的假校验。
 * 2. **`readOnly` 字段不进 Create/Update DTO**。它们由服务端或数据库产生（如 id、createdAt），
 *    放进 DTO 等于允许客户端覆盖，是最常见的越权写入来源。
 * 3. **regex 用 `new RegExp('...')` 而不是正则字面量**。IR 里的 pattern 源码可能含 `/`，
 *    直接拼成 `/a/b/` 会生成语法错误，而这种错误在源 IR 里看起来完全正常。
 * 4. **枚举优先引用生成的 enum，没有就退化为 `@IsIn([...])`**。引用 enum 能让 Swagger 显示
 *    可选值列表；退化分支只保证校验正确，不保证文档好看。
 */

import { toPascalCase, type Field } from '@fsdt/core-ir';
import { Writer, quote } from '@fsdt/generators-runtime';
import { isOptionalField, tsTypeOfField, type TypeCtx } from './type-map.js';

export interface DtoFieldContext extends TypeCtx {
  /** 生成哪个 DTO，用于命名嵌套类型 */
  dtoName: string;
}

/** 一个字段在 DTO 里需要的全部信息，先算清再输出，避免渲染分支里到处查索引 */
interface FieldModel {
  field: Field;
  tsType: string;
  decorators: string[];
  validatorDecorators: string[];
}

function validatorsOf(ctx: DtoFieldContext, field: Field): string[] {
  const out: string[] = [];
  const c = field.constraints ?? {};
  const optional = isOptionalField(field);

  if (optional) out.push('@IsOptional()');

  switch (field.type) {
    case 'string':
    case 'text':
      out.push('@IsString()');
      break;
    case 'file':
      out.push('@IsString()');
      break;
    case 'number':
      out.push('@IsNumber()');
      break;
    case 'integer':
      out.push('@IsInt()');
      break;
    case 'boolean':
      out.push('@IsBoolean()');
      break;
    case 'date':
    case 'datetime':
      out.push('@IsDateString()');
      break;
    case 'enum': {
      if (c.enumRef !== undefined) {
        const def = ctx.g.enums.get(c.enumRef);
        if (def !== undefined) out.push(`@IsEnum(${toPascalCase(def.name)})`);
        else out.push('@IsString()');
      } else if (c.enumValues !== undefined && c.enumValues.length > 0) {
        out.push(`@IsIn([${c.enumValues.map((v) => quote(v)).join(', ')}])`);
      } else {
        // 枚举没定义值属于 IR 层面的问题（Lint L008 会拦），这里只要不生成非法代码
        out.push('@IsString()');
      }
      break;
    }
    case 'array':
      out.push('@IsArray()');
      break;
    case 'object':
      out.push('@IsObject()');
      break;
    case 'json':
      out.push('@IsObject()');
      break;
    case 'ref': {
      const tsType = tsTypeOfField(ctx, field);
      out.push(tsType === 'number' ? '@IsInt()' : '@IsString()');
      break;
    }
    default:
      out.push('@IsString()');
  }

  // 必填的字符串/数组：空字符串能通过 @IsString()，所以要显式拒空
  if (!optional && (field.type === 'string' || field.type === 'text' || field.type === 'array')) {
    out.push('@IsNotEmpty()');
  }
  if (c.minLength !== undefined) out.push(`@MinLength(${c.minLength})`);
  if (c.maxLength !== undefined) out.push(`@MaxLength(${c.maxLength})`);
  if (c.minimum !== undefined) out.push(`@Min(${c.minimum})`);
  if (c.maximum !== undefined) out.push(`@Max(${c.maximum})`);
  if (c.pattern !== undefined) {
    // 必须用 new RegExp：pattern 里出现 `/` 会让字面量语法崩掉
    out.push(`@Matches(new RegExp(${quote(c.pattern)}))`);
  }
  if (field.type === 'array' && c.arrayItem !== undefined && c.arrayItem !== 'object' && c.arrayItem !== 'json') {
    out.push(...arrayItemValidators(c.arrayItem));
  }
  return out;
}

function arrayItemValidators(item: string): string[] {
  switch (item) {
    case 'string':
    case 'text':
      return ['@IsString({ each: true })'];
    case 'integer':
      return ['@IsInt({ each: true })'];
    case 'number':
      return ['@IsNumber({}, { each: true })'];
    case 'boolean':
      return ['@IsBoolean({ each: true })'];
    default:
      return [];
  }
}

function modelOf(ctx: DtoFieldContext, field: Field, useSwagger: boolean): FieldModel {
  const optional = isOptionalField(field);
  const description = field.comment ?? field.description;
  const swagger: string[] = [];
  const enumRef = field.constraints?.enumRef;
  const enumDef = enumRef !== undefined ? ctx.g.enums.get(enumRef) : undefined;
  const extra: string[] = [];
  if (description !== undefined) extra.push(`description: ${quote(description)}`);
  if (enumDef !== undefined) {
    extra.push(`enum: ${toPascalCase(enumDef.name)}`);
    extra.push(`enumName: ${quote(`${ctx.dtoName}${toPascalCase(field.name)}`)}`);
  } else if (field.type === 'enum' && field.constraints?.enumValues !== undefined) {
    extra.push(`enum: [${field.constraints.enumValues.map((v) => quote(v)).join(', ')}]`);
  }
  if (field.example !== undefined) extra.push(`example: ${JSON.stringify(field.example)}`);
  if (field.deprecated === true) extra.push('deprecated: true');

  // swagger 关闭时不生成文档装饰器：package.json 里也没有 @nestjs/swagger，
  // 生成了就是 import 一个不存在的包
  if (useSwagger) {
    const decorator = optional ? 'ApiPropertyOptional' : 'ApiProperty';
    swagger.push(extra.length > 0 ? `@${decorator}({ ${extra.join(', ')} })` : `@${decorator}()`);
  }

  return {
    field,
    tsType: tsTypeOfField(ctx, field),
    decorators: swagger,
    validatorDecorators: validatorsOf(ctx, field),
  };
}

export interface DtoSpec {
  /** 类名，如 CreateDeviceDto */
  className: string;
  /** 文件名（不含 .ts），如 create-device.dto */
  fileName: string;
  fields: Field[];
  /** 父类 PartialType(...)，用于 Update DTO */
  extendsFrom?: string;
  /** 是否需要 import 的额外符号（如 PartialType） */
  extras?: string[];
}

export interface RenderedDto {
  className: string;
  fileName: string;
  content: string;
}

export interface RenderDtoOptions {
  /** 生成 @nestjs/swagger 装饰器，默认 true（与 settings.backend.swagger 一致） */
  swagger?: boolean;
}

export function renderDto(ctx: DtoFieldContext, spec: DtoSpec, options: RenderDtoOptions = {}): RenderedDto {
  const useSwagger = options.swagger ?? true;
  const w = new Writer();
  // readOnly 字段（id、createdAt、写入方是服务端的字段）绝不进请求 DTO：
  // 放进去等于把「客户端可以覆盖主键」写进契约，这是最常见的越权写入来源。
  // 过滤放在这里而不是调用方，是因为调用方有三处（plan / controller / 直调），
  // 只要漏一处就会有一条路径把 readOnly 字段漏出去。
  const requestFields = spec.fields.filter((f) => f.readOnly !== true);
  const models = requestFields.map((f) => modelOf(ctx, f, useSwagger));

  const validatorNames = new Set<string>();
  const usedEnums = new Set<string>();
  const usedSwagger = new Set<string>();
  for (const m of models) {
    for (const d of m.validatorDecorators) {
      const name = /^@([A-Za-z0-9_]+)/.exec(d)?.[1];
      if (name !== undefined) validatorNames.add(name);
    }
    for (const d of m.decorators) {
      const name = /^@([A-Za-z0-9_]+)/.exec(d)?.[1];
      if (name !== undefined) usedSwagger.add(name);
    }
    const enumDef = m.field.constraints?.enumRef;
    if (enumDef !== undefined) {
      const def = ctx.g.enums.get(enumDef);
      if (def !== undefined) usedEnums.add(toPascalCase(def.name));
    }
  }

  // PartialType 有两个来源：swagger 开着时从 @nestjs/swagger 拿（它会把字段一并
  // 标成可选并保留文档元数据），关着时退到 @nestjs/mapped-types——后者是前者的底座，
  // 不依赖 swagger 也能把字段变可选。
  if (spec.extendsFrom !== undefined) {
    if (useSwagger) usedSwagger.add('PartialType');
  }

  const isPartial = spec.extendsFrom !== undefined;

  // 导入分组：校验器来自 class-validator，文档装饰器来自 @nestjs/swagger，
  // 枚举来自 @prisma/client（它是运行时值，不是类型，不能写成 import type）。
  if (validatorNames.size > 0) {
    w.line(`import { ${[...validatorNames].sort().join(', ')} } from 'class-validator';`);
  }
  if (usedSwagger.size > 0) {
    w.line(`import { ${[...usedSwagger].sort().join(', ')} } from '@nestjs/swagger';`);
  }
  if (!useSwagger && spec.extendsFrom !== undefined) {
    w.line("import { PartialType } from '@nestjs/mapped-types';");
  }
  if (usedEnums.size > 0) {
    w.line(`import { ${[...usedEnums].sort().join(', ')} } from '@prisma/client';`);
  }
  for (const line of spec.extras ?? []) w.line(line);
  w.blank();

  const extendsClause = spec.extendsFrom !== undefined ? ` extends PartialType(${spec.extendsFrom})` : '';
  w.line(`export class ${spec.className}${extendsClause} {`);
  if (!isPartial) {
    for (const m of models) {
      const optional = isOptionalField(m.field);
      for (const d of m.decorators) w.line(`  ${d}`);
      for (const d of m.validatorDecorators) w.line(`  ${d}`);
      w.line(`  ${m.field.name}${optional ? '?' : '!'}: ${m.tsType};`);
      w.blank();
    }
  }
  w.line('}');

  return { className: spec.className, fileName: spec.fileName, content: w.toString() };
}
