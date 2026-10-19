/**
 * 接口分组与路径拆分。
 *
 * 为什么按「路径首段」分组而不是按 IR 表节点分组：接口节点是**独立于表的良构公民**
 * （可以指向第三方 API、可以没有对应表），强行绑到表上会让「订单列表 + 订单详情 +
 * 发货」散落在不同模块。而 REST 的路径首段天然就是资源名，也是用户心里的「模块」。
 *
 * 这条规则必须与 Vue 生成器的 `apiModulePath` 一致：前后端各自的模块名对不上时，
 * 排查问题的人要在两套命名之间来回翻译。
 */

import { toCamelCase, toKebabCase, toPascalCase, type ApiNode, type IR } from '@fsdt/core-ir';

export interface ResourceGroup {
  /** kebab-case 分段名，如 devices */
  segment: string;
  /** PascalCase 模块名，如 Devices */
  className: string;
  /** 模块目录名，与 segment 相同 */
  dir: string;
  apis: ApiNode[];
}

/** `/devices/{id}/status` → ['devices', '{id}', 'status'] */
export function pathSegments(path: string): string[] {
  return path.split('/').filter((s) => s.length > 0);
}

/** 资源名取第一个非参数段；全是参数或根路径时退化为 'root' */
export function resourceSegmentOf(api: ApiNode): string {
  const seg = pathSegments(api.api.path).find((s) => !s.startsWith('{'));
  return toKebabCase(seg ?? 'root');
}

/** 去掉资源段后的剩余路径，用于 @Get(':id') 这类装饰器 */
export function subPathOf(api: ApiNode): string {
  const segments = pathSegments(api.api.path);
  const first = segments.findIndex((s) => !s.startsWith('{'));
  const rest = first === -1 ? segments : segments.slice(first + 1);
  return rest
    .map((s) => (s.startsWith('{') && s.endsWith('}') ? `:${s.slice(1, -1)}` : s))
    .join('/');
}

export function groupByResource(ir: IR): ResourceGroup[] {
  const groups = new Map<string, ResourceGroup>();
  const apis = ir.nodes
    .filter((n): n is ApiNode => n.kind === 'api')
    .slice()
    .sort((a, b) => {
      if (a.api.path !== b.api.path) return a.api.path < b.api.path ? -1 : 1;
      return a.api.method < b.api.method ? -1 : a.api.method > b.api.method ? 1 : 0;
    });

  for (const api of apis) {
    const segment = resourceSegmentOf(api);
    const group = groups.get(segment) ?? {
      segment,
      className: toPascalCase(segment),
      dir: segment,
      apis: [],
    };
    group.apis.push(api);
    groups.set(segment, group);
  }

  return [...groups.values()].sort((a, b) => (a.segment < b.segment ? -1 : a.segment > b.segment ? 1 : 0));
}

/** 控制器类名：DevicesController */
export function controllerClassOf(group: ResourceGroup): string {
  return `${group.className}Controller`;
}

/** 服务类名：DevicesService */
export function serviceClassOf(group: ResourceGroup): string {
  return `${group.className}Service`;
}

/** 服务变量名：devicesService */
export function serviceVarOf(group: ResourceGroup): string {
  return toCamelCase(`${group.className}Service`);
}

/** DTO 类名：createDevice → CreateDeviceDto / CreateDeviceQueryDto */
export function dtoClassOf(operationId: string, suffix: 'Dto' | 'QueryDto'): string {
  return `${toPascalCase(operationId)}${suffix}`;
}

/**
 * DTO 文件路径（无扩展名），供 controller / service 共用。
 *
 * 必须只在一个地方算：controller 与 service 各自拼一遍，只要有一处大小写或分隔符
 * 不同，生成出来的工程就会有「找不到模块」的编译错误，而错误信息只会指向 import。
 */
export function requestDtoFileOf(operationId: string): string {
  return `./dto/${toKebabCase(operationId)}.dto`;
}

/** plan 阶段用的包内相对路径（不含前导 ./），与 requestDtoFileOf 必须保持一致 */
export function requestDtoPathOf(operationId: string): string {
  return `dto/${toKebabCase(operationId)}.dto.ts`;
}

export function queryDtoFileOf(operationId: string): string {
  return `./dto/${toKebabCase(operationId)}-query.dto`;
}

export function queryDtoPathOf(operationId: string): string {
  return `dto/${toKebabCase(operationId)}-query.dto.ts`;
}

export function responseFileOf(operationId: string): string {
  return `./dto/${toKebabCase(operationId)}-response`;
}

export function responsePathOf(operationId: string): string {
  return `dto/${toKebabCase(operationId)}-response.ts`;
}
