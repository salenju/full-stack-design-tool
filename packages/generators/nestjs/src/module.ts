/**
 * NestJS 模块、应用装配与工程配置文件。
 *
 * 装配类文件的共同特点：**内容几乎不随 IR 变化，但一旦写错整个工程起不来**。
 * 所以这里宁可显式罗列（`imports: [DevicesModule]`），也不做「扫描目录自动装配」
 * 之类的魔法——生成器输出要能被不熟悉本工具的人直接读懂。
 */

import { toPackageName, type IR } from '@fsdt/core-ir';
import { regionEnd, regionStart, Writer, quote } from '@fsdt/generators-runtime';
import { controllerClassOf, serviceClassOf, type ResourceGroup } from './resource.js';

export interface AssembleOptions {
  ir: IR;
  irHash: string;
  groups: ResourceGroup[];
}

export function renderModule(group: ResourceGroup, irHash: string): string {
  const w = new Writer();
  w.line(
    `// @dsg:generated file=src/modules/${group.dir}/${group.dir}.module.ts node=${group.apis.map((a) => a.id).join(',')} ir=${irHash} generator=nestjs@0.1.0`,
  );
  w.line("import { Module } from '@nestjs/common';");
  w.line(`import { ${controllerClassOf(group)} } from './${group.dir}.controller';`);
  w.line(`import { ${serviceClassOf(group)} } from './${group.dir}.service';`);
  w.blank();
  w.line('@Module({');
  w.line(`  controllers: [${controllerClassOf(group)}],`);
  w.line(`  providers: [${serviceClassOf(group)}],`);
  w.line(`  exports: [${serviceClassOf(group)}],`);
  w.line('})');
  w.line(`export class ${group.className}Module {}`);
  return w.toString();
}

export function renderAppModule(options: AssembleOptions): string {
  const w = new Writer();
  w.line(`// @dsg:generated file=src/app.module.ts ir=${options.irHash} generator=nestjs@0.1.0`);
  w.line("import { Module } from '@nestjs/common';");
  w.line("import { PrismaModule } from './prisma/prisma.module';");
  for (const group of options.groups) {
    w.line(`import { ${group.className}Module } from './modules/${group.dir}/${group.dir}.module';`);
  }
  w.blank();
  w.line('@Module({');
  w.line('  imports: [');
  w.line('    PrismaModule,');
  for (const group of options.groups) {
    w.line(`    ${group.className}Module,`);
  }
  w.line('  ],');
  w.line('})');
  w.line('export class AppModule {}');
  return w.toString();
}

export function renderPrismaModule(irHash: string): string {
  const w = new Writer();
  w.line(`// @dsg:generated file=src/prisma/prisma.module.ts ir=${irHash} generator=nestjs@0.1.0`);
  w.line("import { Global, Module } from '@nestjs/common';");
  w.line("import { PrismaService } from './prisma.service';");
  w.blank();
  w.line('/**');
  w.line(' * 标 @Global 的理由：几乎每个 service 都要写库，逐个模块 imports: [PrismaModule]');
  w.line(' * 只会让模块文件变噪，且新增模块时容易忘。');
  w.line(' */');
  w.line('@Global()');
  w.line('@Module({');
  w.line('  providers: [PrismaService],');
  w.line('  exports: [PrismaService],');
  w.line('})');
  w.line('export class PrismaModule {}');
  return w.toString();
}

export function renderPrismaService(irHash: string): string {
  const w = new Writer();
  w.line(`// @dsg:generated file=src/prisma/prisma.service.ts ir=${irHash} generator=nestjs@0.1.0`);
  w.line("import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';");
  w.line("import { PrismaClient } from '@prisma/client';");
  w.blank();
  w.line('@Injectable()');
  w.line('export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {');
  w.line('  async onModuleInit(): Promise<void> {');
  w.line('    await this.$connect();');
  w.line('  }');
  w.blank();
  w.line('  async onModuleDestroy(): Promise<void> {');
  w.line('    await this.$disconnect();');
  w.line('  }');
  w.line('}');
  return w.toString();
}

export interface MainTsOptions {
  /** 是否装配 SwaggerModule（跟 settings.backend.swagger 走） */
  swagger: boolean;
  /** 文档标题，用项目名 */
  title: string;
}

export function renderMainTs(irHash: string, options: MainTsOptions): string {
  const w = new Writer();
  w.line(`// @dsg:generated file=src/main.ts ir=${irHash} generator=nestjs@0.1.0`);
  w.line("import { ValidationPipe } from '@nestjs/common';");
  w.line("import { NestFactory } from '@nestjs/core';");
  if (options.swagger) w.line("import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';");
  w.line("import { AppModule } from './app.module';");
  w.line("import { AllExceptionsFilter } from './common/http-exception.filter';");
  w.blank();
  w.line('async function bootstrap(): Promise<void> {');
  w.line('  const app = await NestFactory.create(AppModule);');
  w.blank();
  w.line('  // 白名单 + forbidNonWhitelisted：多传字段直接 400，而不是静默忽略。');
  w.line('  // 静默忽略会让前端把字段名拼错时完全无感，联调时最难查。');
  w.line('  app.useGlobalPipes(');
  w.line('    new ValidationPipe({');
  w.line('      whitelist: true,');
  w.line('      forbidNonWhitelisted: true,');
  w.line('      transform: true,');
  w.line('      transformOptions: { enableImplicitConversion: true },');
  w.line('    }),');
  w.line('  );');
  w.blank();
  w.line('  // 统一异常格式：把 HttpException 与未捕获异常都收敛成 { statusCode, message, path }');
  w.line('  app.useGlobalFilters(new AllExceptionsFilter());');
  w.blank();
  // 鉴权挂载点包进 todo 区块：这一处几乎每个项目都要改，而它所在的 main.ts
  // 又会随 Swagger 开关、全局前缀变化被重新生成。不包区块的话，接一次鉴权
  // 就要在每次重新生成后重接一次。
  const authHook = [
    '  // 接入鉴权（本工具不生成 JWT 骨架）',
    '  // app.useGlobalGuards(new JwtAuthGuard(reflector));',
    '  // 若使用公司 SSO / 网关鉴权，在此替换为实现了 CanActivate 的 Guard。',
    '  // 注意：登录路由必须用 @Public() 之类机制反向放行，否则会死循环。',
  ].join('\n');
  w.line(`  ${regionStart('ts', 'auth', authHook, 'todo')}`);
  w.lines_(authHook);
  w.line(`  ${regionEnd('ts', 'auth', 'todo')}`);
  w.blank();
  w.line("  app.setGlobalPrefix('api');");
  w.line('  app.enableCors({ origin: true, credentials: true });');
  if (options.swagger) {
    w.blank();
    w.line('  const config = new DocumentBuilder()');
    w.line(`    .setTitle(${quote(options.title)})`);
    w.line("    .setVersion('0.1.0')");
    w.line('    .build();');
    w.line('  SwaggerModule.setup(');
    w.line("    'docs',");
    w.line('    app,');
    w.line('    SwaggerModule.createDocument(app, config),');
    w.line('  );');
  }
  w.blank();
  w.line('  await app.listen(Number(process.env.PORT ?? 3000));');
  w.line('}');
  w.blank();
  w.line('void bootstrap();');
  return w.toString();
}

export function renderPackageJson(projectName: string, ir: IR): string {
  const pkg = {
    // 与前端同理：必须能通过 npm 包名校验（中文项目名会导致装不上）
    // 先剥项目名再拼后缀：直接对整个字符串取包名会让中文项目名退化成一模一样的 'backend'
    name: `${toPackageName(projectName, '') || 'fsdt'}-backend`,
    version: '0.1.0',
    private: true,
    scripts: {
      build: 'nest build',
      start: 'nest start',
      'start:dev': 'nest start --watch',
      'db:generate': 'prisma generate',
      'db:migrate': 'prisma migrate dev',
      test: 'jest',
    },
    dependencies: {
      '@nestjs/common': '^12.2.0',
      '@nestjs/core': '^12.2.0',
      '@nestjs/platform-express': '^12.2.0',
      // 关闭 swagger 时改由 mapped-types 提供 PartialType（Update DTO 要用），
      // 它的体积只有一个装饰器，不连带 swagger 那一整套
      ...(ir.settings.backend.swagger
        ? { '@nestjs/swagger': '^12.0.2' }
        : { '@nestjs/mapped-types': '^2.1.0' }),
      '@prisma/client': '^7.10.1',
      'class-transformer': '^0.5.1',
      'class-validator': '^0.14.1',
      'reflect-metadata': '^0.2.2',
      rxjs: '^7.8.2',
    },
    devDependencies: {
      '@nestjs/cli': '^12.0.8',
      '@types/node': '^24.10.1',
      prisma: '^7.10.1',
      typescript: '5.9.3',
    },
  };
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

export function renderTsconfig(): string {
  const cfg = {
    compilerOptions: {
      module: 'commonjs',
      declaration: true,
      removeComments: true,
      emitDecoratorMetadata: true,
      experimentalDecorators: true,
      allowSyntheticDefaultImports: true,
      target: 'ES2023',
      sourceMap: true,
      outDir: './dist',
      baseUrl: './',
      incremental: true,
      skipLibCheck: true,
      strictNullChecks: true,
      noImplicitAny: true,
      strictBindCallApply: true,
      forceConsistentCasingInFileNames: true,
      noFallthroughCasesInSwitch: true,
    },
    include: ['src/**/*'],
    exclude: ['node_modules', 'dist'],
  };
  return `${JSON.stringify(cfg, null, 2)}\n`;
}

/**
 * `prisma.config.ts`。
 *
 * Prisma 7 把连接串从 schema 里挪出来了：`datasource.url` 写在
 * `prisma/schema.prisma` 会直接报 P1012（The datasource property `url` is no
 * longer supported），任何 `prisma generate` / `migrate` 都跑不起来。
 * 生成器若只产 schema，用户拿到的项目第一步就报错，而且错误信息指向
 * schema 第 10 行——看不出是「Prisma 版本变了」。
 */
export function renderPrismaConfig(): string {
  const w = new Writer();
  w.line("import { defineConfig, env } from 'prisma/config';");
  w.blank();
  w.line('export default defineConfig({');
  w.line("  schema: 'prisma/schema.prisma',");
  w.line('  datasource: {');
  w.line("    url: env('DATABASE_URL'),");
  w.line('  },');
  w.line('});');
  return w.toString();
}

export function renderNestCli(): string {
  const cfg = {
    $schema: 'https://json.schemastore.org/nest-cli',
    collection: '@nestjs/schematics',
    sourceRoot: 'src',
    compilerOptions: { deleteOutDir: true },
  };
  return `${JSON.stringify(cfg, null, 2)}\n`;
}

export function renderEnvExample(): string {
  return [
    '# 复制为 .env 后填写。不要把真实连接串提交到仓库。',
    'DATABASE_URL="postgresql://user:password@localhost:5432/app?schema=public"',
    'PORT=3000',
    '',
  ].join('\n');
}
