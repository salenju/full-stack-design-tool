/**
 * 生成产物**真编译**测试。
 *
 * 为什么值得为它写一个跑 tsc 的重测试：前面写生成器时已经踩过两次
 * 「输出看起来完全正常、但一编译就报错」的坑——`@Get()` 忘了 import、DTO 的
 * `./dto/` 路径少一层。这两类问题靠字符串断言基本抓不到（你得正好断言到那一行），
 * 而 tsc 一次就能全部指出，包括「import 的模块在磁盘上不存在」。
 *
 * 外部依赖（@nestjs/*、class-validator、@prisma/client）用环境声明桩替代：
 * 桩里的符号类型全是 any，所以**能**验证的是「标识符是否存在、模块路径是否可解析、
 * 语法是否成立」，不能验证类型是否正确。这正好是生成器最容易出错的部分。
 */

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { buildFixture } from '@fsdt/core-ir/testing';
import type { IR } from '@fsdt/core-ir';
import { describe, expect, it } from 'vitest';
import { nestjsGenerator } from '../src/index.js';

const run = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const tscBin = join(repoRoot, 'node_modules/typescript/bin/tsc');

const CTX = { projectName: 'Demo', outputRoot: '.' };

/** 外部模块的环境声明桩：只声明「有哪些符号」，不声明类型 */
const STUBS = `
declare module '@nestjs/common' {
  export const Controller: any;
  export const Get: any;
  export const Post: any;
  export const Put: any;
  export const Patch: any;
  export const Delete: any;
  export const Body: any;
  export const Query: any;
  export const Param: any;
  export const Injectable: any;
  export const Module: any;
  export const Global: any;
  export const ValidationPipe: any;
  export const Catch: any;
  export const Logger: any;
  export const HttpStatus: any;
  // 这几个在生成代码里是「类型位置」用的（implements ExceptionFilter / 参数类型），
  // 必须声明成 interface；声明成 const 会得到「值被当类型用」的 TS2749
  export interface ExceptionFilter {
    catch(exception: unknown, host: ArgumentsHost): void;
  }
  export interface ArgumentsHost {
    switchToHttp(): { getResponse<T>(): T; getRequest<T>(): T };
  }
  export interface CallHandler<T = any> {
    handle(): any;
  }
  export interface ExecutionContext {
    switchToHttp(): any;
  }
  export interface NestInterceptor<T = any, R = any> {
    intercept(context: ExecutionContext, next: CallHandler<T>): any;
  }
  // 声明成 class 而不是 any：生成代码里有 exception instanceof HttpException，
  // 用 any 的话窄化不成立，后面调 getStatus() 会被判成 unknown 上报错
  export class HttpException extends Error {
    getStatus(): number;
    getResponse(): unknown;
  }
  export class NotImplementedException extends Error {}
  export interface OnModuleInit { onModuleInit(): Promise<void> }
  export interface OnModuleDestroy { onModuleDestroy(): Promise<void> }
}
declare module '@nestjs/mapped-types' {
  export const PartialType: any;
}
declare module 'rxjs' {
  export interface Observable<T> { subscribe(next: (value: T) => void): void }
}
declare module 'rxjs/operators' {
  export function map<T, R>(fn: (value: T) => R): (source: unknown) => unknown;
}
declare module '@nestjs/core' {
  export const NestFactory: any;
}
declare module '@nestjs/swagger' {
  export const ApiProperty: any;
  export const ApiPropertyOptional: any;
  export const ApiTags: any;
  export const ApiOkResponse: any;
  export const PartialType: any;
  export const DocumentBuilder: any;
  export const SwaggerModule: any;
}
declare module 'class-validator' {
  export const IsString: any;
  export const IsNumber: any;
  export const IsInt: any;
  export const IsBoolean: any;
  export const IsDateString: any;
  export const IsEnum: any;
  export const IsIn: any;
  export const IsArray: any;
  export const IsObject: any;
  export const IsNotEmpty: any;
  export const IsOptional: any;
  export const MinLength: any;
  export const MaxLength: any;
  export const Min: any;
  export const Max: any;
  export const Matches: any;
}
declare module 'class-transformer' {
  export const Type: any;
}
declare module '@prisma/client' {
  export class PrismaClient { $connect(): Promise<void>; $disconnect(): Promise<void> }
}
`;

/** Prisma 枚举要逐个声明，桩里没法用通配符导出 */
function prismaEnumStub(ir: IR): string {
  const enums = ir.dictionaries.enums
    .map((def) => `declare module '@prisma/client' { export enum ${def.name} { ${def.values.map((v) => v.value).join(', ')} } }`)
    .join('\n');
  return enums;
}

async function renderProject(ir: IR): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fsdt-nestjs-'));
  const plans = nestjsGenerator.plan(ir, CTX);
  for (const plan of plans) {
    const file = await nestjsGenerator.render(plan, ir, CTX);
    const target = join(dir, plan.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content, 'utf8');
  }
  await writeFile(join(dir, 'stubs.d.ts'), `${STUBS}\n${prismaEnumStub(ir)}\n`, 'utf8');
  await writeFile(
    join(dir, 'tsconfig.check.json'),
    JSON.stringify(
      {
        // 关闭 strict：桩里全是 any，开着只会报「any 不能用作装饰器」这类噪音，
        // 而我们要抓的是「标识符/模块解析」层面的错。
        compilerOptions: {
          target: 'ES2023',
          module: 'commonjs',
          moduleResolution: 'node',
          experimentalDecorators: true,
          strict: false,
          noEmit: true,
          skipLibCheck: true,
          esModuleInterop: true,
          // 临时目录在仓库外，@types/node 只能靠 typeRoots 显式指回去；
          // 不引入它的话 process/PORT 这类再平常不过的用法都会报错。
          types: ['node'],
          typeRoots: [join(repoRoot, 'node_modules/@types')],
        },
        include: ['src/**/*.ts', 'stubs.d.ts'],
      },
      null,
      2,
    ),
    'utf8',
  );
  return dir;
}

describe('生成的 NestJS 工程能通过 tsc', () => {
  it('fixture 的完整产物编译无错（含模块路径、装饰器导入）', async () => {
    const { ir } = buildFixture();
    const dir = await renderProject(ir);
    try {
      await run(process.execPath, [tscBin, '-p', join(dir, 'tsconfig.check.json')]);
    } catch (error) {
      const e = error as { stdout?: string; stderr?: string };
      throw new Error(`生成代码编译失败：\n${e.stdout ?? ''}${e.stderr ?? ''}`);
    }
    expect(true).toBe(true);
  }, 60_000);

  it('带外键、软删除、多接口的 IR 也能编译', async () => {
    const { ir, deviceTable, listPage } = buildFixture();
    // 加一张引用 deviceTable 的表，覆盖 @relation 与反向字段的生成
    const { createTableNode, createField: mkField } = await import('@fsdt/core-ir');
    const commandTable = createTableNode({
      name: '指令',
      codeName: 'Command',
      canvasId: deviceTable.canvasId,
      table: {
        dbName: 'commands',
        fields: [
          mkField({ name: 'id', type: 'integer', required: true, dbName: 'id' }),
          mkField({
            name: 'deviceId',
            type: 'ref',
            required: true,
            dbName: 'device_id',
            constraints: { ref: { tableId: deviceTable.id, fieldId: deviceTable.table.fields[0]?.id, onDelete: 'cascade' } },
          }),
          mkField({ name: 'payload', type: 'json', required: false, dbName: 'payload' }),
        ],
        indexes: [],
        softDelete: true,
        timestamps: true,
      },
    });
    ir.nodes.push(commandTable);
    void listPage;
    const dir = await renderProject(ir);
    try {
      await run(process.execPath, [tscBin, '-p', join(dir, 'tsconfig.check.json')]);
    } catch (error) {
      const e = error as { stdout?: string; stderr?: string };
      throw new Error(`生成代码编译失败：\n${e.stdout ?? ''}${e.stderr ?? ''}`);
    }
    expect(true).toBe(true);
  }, 60_000);
});
