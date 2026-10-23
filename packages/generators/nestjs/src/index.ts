/**
 * NestJS 后端代码生成器。
 *
 * 输入是 **IR**，不经过 UI Schema：UI Schema 描述的是页面，后端需要的是接口与表，
 * 走 UI Schema 会把「页面上绑定了哪些字段」这种前端信息带进来，导致 DTO 缺字段。
 * 这正是 TD 第 6 章「OpenAPI 与 UI Schema 是并列产物，互不派生」的落地方式。
 *
 * 产物清单（对齐 TD 7.3）：
 * - `prisma/schema.prisma`：由表节点生成
 * - `src/main.ts` / `app.module.ts` / `prisma/*`：装配与挂载点
 * - `src/modules/<资源>/`：controller + service + dto
 *
 * 一条贯穿全文件的纪律：**operationId 只有一个分配器**（compiler 的
 * `allocateOperationIds`），controller 方法名、service 方法名、DTO 类名、
 * 前端 API 函数名都由它派生。任何一处自己重算，都会出现
 * 「契约叫 listDevices、生成的前端去调 listDevices2」这种运行时 404。
 */

import { computeSchemaHash, type IR } from '@fsdt/core-ir';
import type { CodeGenerator, CompileContext, FilePlan, RenderedFile } from '@fsdt/generators-runtime';
import { allocateOperationIds } from '@fsdt/compiler';
import { buildGraphIndex } from '@fsdt/core-ir';
import { emitPrismaSchema } from './prisma.js';
import { renderDto } from './dto.js';
import {
  groupByResource,
  queryDtoPathOf,
  requestDtoPathOf,
  responsePathOf,
  type ResourceGroup,
} from './resource.js';
import { dtoSpecsOf, renderController } from './controller.js';
import { renderService } from './service.js';
import { renderResponseClasses } from './response.js';
import { responseModelOf } from './response.js';
import { renderExceptionFilter, renderPaginationDto, renderResponseInterceptor } from './common.js';
import {
  renderAppModule,
  renderEnvExample,
  renderMainTs,
  renderModule,
  renderNestCli,
  renderPrismaConfig,
  renderPackageJson,
  renderPrismaModule,
  renderPrismaService,
  renderTsconfig,
} from './module.js';
import type { TypeCtx } from './type-map.js';

export const GENERATOR_ID = 'nestjs';
export const GENERATOR_VERSION = '0.1.0';

/** 模块目录: src/modules/devices/devices.controller.ts */
function modulePathOf(group: ResourceGroup, file: string): string {
  return `src/modules/${group.dir}/${file}`;
}

export const nestjsGenerator: CodeGenerator = {
  id: GENERATOR_ID,
  version: GENERATOR_VERSION,

  plan(ir: IR): FilePlan[] {
    // 同 vue 生成器：不支持的值必须显式失败，否则会生成一份「配置写着 typeorm、
    // 代码却是 Prisma」的工程，而用户要到 nest build 才会发现
    if (ir.settings.backend.orm !== 'prisma') {
      throw new Error(
        `后端 ORM「${ir.settings.backend.orm}」暂不支持：NestJS 生成器只实现了 prisma。` +
          '请把 settings.backend.orm 改回 prisma。',
      );
    }

    const groups = groupByResource(ir);
    const allocation = allocateOperationIds(ir);
    const apiNodeIds = ir.nodes.filter((n) => n.kind === 'api').map((n) => n.id);
    const tableNodeIds = ir.nodes.filter((n) => n.kind === 'table').map((n) => n.id);
    const plans: FilePlan[] = [];

    // ── 工程配置：已存在则不覆盖 ──
    // package.json 里会有用户自己加的依赖（比如接入了公司内部 SDK），
    // 覆盖一次就丢一次，所以只能「不存在时创建」。
    plans.push(
      { path: 'package.json', kind: 'config', sourceNodeIds: [], overwrite: 'never' },
      { path: 'tsconfig.json', kind: 'config', sourceNodeIds: [], overwrite: 'never' },
      { path: 'nest-cli.json', kind: 'config', sourceNodeIds: [], overwrite: 'never' },
      { path: '.env.example', kind: 'config', sourceNodeIds: [], overwrite: 'if-generated' },
      {
        path: 'prisma/schema.prisma',
        kind: 'schema',
        sourceNodeIds: tableNodeIds,
        overwrite: 'if-generated',
        description: 'Prisma 数据模型（迁移会长在它之上，手改需谨慎）',
      },
      {
        path: 'prisma.config.ts',
        kind: 'config',
        sourceNodeIds: [],
        overwrite: 'if-generated',
        description: 'Prisma 7 起连接串在这里配置（schema 里已不允许写 url）',
      },
      { path: 'src/main.ts', kind: 'config', sourceNodeIds: [], overwrite: 'if-generated' },
      {
        path: 'src/common/pagination.dto.ts',
        kind: 'dto',
        sourceNodeIds: [],
        overwrite: 'if-generated',
        description: '通用分页参数（page / pageSize）',
      },
      {
        path: 'src/common/http-exception.filter.ts',
        kind: 'config',
        sourceNodeIds: [],
        overwrite: 'if-generated',
        description: '统一异常格式',
      },
      {
        path: 'src/common/response.interceptor.ts',
        kind: 'config',
        sourceNodeIds: [],
        overwrite: 'if-generated',
        description: '统一响应包装（默认不注册）',
      },
      { path: 'src/app.module.ts', kind: 'config', sourceNodeIds: apiNodeIds, overwrite: 'always' },
      { path: 'src/prisma/prisma.module.ts', kind: 'module', sourceNodeIds: [], overwrite: 'if-generated' },
      { path: 'src/prisma/prisma.service.ts', kind: 'module', sourceNodeIds: [], overwrite: 'if-generated' },
    );

    for (const group of groups) {
      plans.push({
        path: modulePathOf(group, `${group.dir}.module.ts`),
        kind: 'module',
        sourceNodeIds: group.apis.map((a) => a.id),
        overwrite: 'always',
      });
      plans.push({
        path: modulePathOf(group, `${group.dir}.controller.ts`),
        kind: 'controller',
        sourceNodeIds: group.apis.map((a) => a.id),
        overwrite: 'always',
        description: `模块 ${group.segment} 的路由与 Swagger 装饰器`,
      });
      plans.push({
        path: modulePathOf(group, `${group.dir}.service.ts`),
        kind: 'service',
        sourceNodeIds: group.apis.map((a) => a.id),
        overwrite: 'if-generated',
        description: `模块 ${group.segment} 的业务逻辑（生成的是显式未实现骨架）`,
      });

      for (const api of group.apis) {
        const operationId = allocation.byNodeId.get(api.id);
        if (operationId === undefined) continue;
        for (const spec of dtoSpecsOf(api, operationId)) {
          const rel = spec.suffix === 'Dto' ? requestDtoPathOf(operationId) : queryDtoPathOf(operationId);
          plans.push({
            path: modulePathOf(group, rel),
            kind: 'dto',
            sourceNodeIds: [api.id],
            overwrite: 'always',
            description: `${spec.className}（class-validator 校验）`,
          });
        }
        const model = responseModelOf(operationId, api);
        if (model.kind !== 'void' && model.kind !== 'raw') {
          plans.push({
            path: modulePathOf(group, responsePathOf(operationId)),
            kind: 'dto',
            sourceNodeIds: [api.id],
            overwrite: 'always',
            description: `${operationId} 的响应类型（供 Swagger 与 service 返回值使用）`,
          });
        }
      }
    }

    // 去重 + 稳定排序：plan 的顺序会直接决定写入顺序与 manifest 顺序
    const seen = new Set<string>();
    return plans
      .filter((p) => (seen.has(p.path) ? false : (seen.add(p.path), true)))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  },

  async render(plan: FilePlan, ir: IR, ctx: CompileContext): Promise<RenderedFile> {
    const groups = groupByResource(ir);
    const allocation = allocateOperationIds(ir);
    const irHash = computeSchemaHash(ir);
    const typeCtx: TypeCtx = { ir, g: buildGraphIndex(ir) };
    const base = {
      path: plan.path,
      kind: plan.kind,
      sourceNodeIds: plan.sourceNodeIds,
      overwrite: plan.overwrite,
      regions: [] as RenderedFile['regions'],
    };

    // 先按路径找模块，再分派：文件路径是唯一的，比按 kind 分支更不容易出错
    for (const group of groups) {
      if (!plan.path.startsWith(`src/modules/${group.dir}/`)) continue;
      const rest = plan.path.slice(`src/modules/${group.dir}/`.length);

      if (rest === `${group.dir}.module.ts`) {
        return { ...base, language: 'ts', content: renderModule(group, irHash) };
      }
      if (rest === `${group.dir}.controller.ts`) {
        return {
          ...base,
          language: 'ts',
          content: renderController(typeCtx, group, {
            operationIdOf: allocation.byNodeId,
            irHash,
            swagger: ir.settings.backend.swagger,
          }),
        };
      }
      if (rest === `${group.dir}.service.ts`) {
        return {
          ...base,
          language: 'ts',
          content: renderService(typeCtx, group, { operationIdOf: allocation.byNodeId, irHash }),
        };
      }

      // DTO / 响应类：按后缀回查是哪条接口
      for (const api of group.apis) {
        const operationId = allocation.byNodeId.get(api.id);
        if (operationId === undefined) continue;

        for (const spec of dtoSpecsOf(api, operationId)) {
          const rel = spec.suffix === 'Dto' ? requestDtoPathOf(operationId) : queryDtoPathOf(operationId);
          if (rest === rel) {
            const rendered = renderDto(
              { ...typeCtx, dtoName: spec.className.replace(/Dto$/, '') },
              {
                className: spec.className,
                fileName: rest,
                fields: spec.fields,
              },
              { swagger: ir.settings.backend.swagger },
            );
            return { ...base, language: 'ts', content: rendered.content };
          }
        }

        const model = responseModelOf(operationId, api);
        if (model.kind !== 'void' && model.kind !== 'raw') {
          if (rest === responsePathOf(operationId)) {
            const rendered = renderResponseClasses(typeCtx, operationId, api, {
              swagger: ir.settings.backend.swagger,
            });
            if (rendered !== undefined) return { ...base, language: 'ts', content: rendered.content };
          }
        }
      }
    }

    switch (plan.path) {
      case 'prisma/schema.prisma':
        return { ...base, language: 'prisma', content: emitPrismaSchema(ir).schema };
      case 'src/main.ts':
        return {
          ...base,
          language: 'ts',
          content: renderMainTs(irHash, { swagger: ir.settings.backend.swagger, title: ir.project.name }),
        };
      case 'src/common/pagination.dto.ts':
        return { ...base, language: 'ts', content: renderPaginationDto(irHash) };
      case 'src/common/http-exception.filter.ts':
        return { ...base, language: 'ts', content: renderExceptionFilter(irHash) };
      case 'src/common/response.interceptor.ts':
        return { ...base, language: 'ts', content: renderResponseInterceptor(irHash) };
      case 'src/app.module.ts':
        return { ...base, language: 'ts', content: renderAppModule({ ir, irHash, groups }) };
      case 'src/prisma/prisma.module.ts':
        return { ...base, language: 'ts', content: renderPrismaModule(irHash) };
      case 'src/prisma/prisma.service.ts':
        return { ...base, language: 'ts', content: renderPrismaService(irHash) };
      case 'package.json':
        return { ...base, language: 'json', content: renderPackageJson(ctx.projectName, ir) };
      case 'tsconfig.json':
        return { ...base, language: 'json', content: renderTsconfig() };
      case 'nest-cli.json':
        return { ...base, language: 'json', content: renderNestCli() };
      case '.env.example':
        return { ...base, language: 'env', content: renderEnvExample() };
      case 'prisma.config.ts':
        return { ...base, language: 'ts', content: renderPrismaConfig() };
      default:
        break;
    }

    throw new Error(`nestjsGenerator 无法渲染未知文件：${plan.path}`);
  },
};

export { emitPrismaSchema } from './prisma.js';
export type { PrismaEmitOptions, PrismaEmitResult } from './prisma.js';
export { renderDto } from './dto.js';
export type { DtoSpec, RenderedDto } from './dto.js';
export {
  groupByResource,
  resourceSegmentOf,
  subPathOf,
  controllerClassOf,
  serviceClassOf,
  dtoClassOf,
  queryDtoFileOf,
  queryDtoPathOf,
  requestDtoFileOf,
  requestDtoPathOf,
  responseFileOf,
  responsePathOf,
} from './resource.js';
export type { ResourceGroup } from './resource.js';
export { renderController, dtoSpecsOf } from './controller.js';
export { renderService } from './service.js';
export { responseModelOf, renderResponseClasses, responseTsTypeOf } from './response.js';
export type { ResponseModel, ResponseSpec } from './response.js';
export { tsTypeOfField, isOptionalField } from './type-map.js';
export type { TypeCtx } from './type-map.js';
export {
  renderModule,
  renderAppModule,
  renderMainTs,
  renderPackageJson,
  renderTsconfig,
  renderNestCli,
  renderEnvExample,
  renderPrismaConfig,
} from './module.js';
