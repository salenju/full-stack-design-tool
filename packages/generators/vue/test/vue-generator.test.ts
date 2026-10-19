import { describe, expect, it } from 'vitest';

import { buildFixture } from '@fsdt/core-ir/testing';
import type { IR } from '@fsdt/core-ir';

import { emitUiSchema } from '@fsdt/compiler';

import {
  apiModulePath,
  buildPageModel as buildPageModelForTest,
  GENERATOR_ID,
  INLINE_THRESHOLD,
  renderApiTypes,
  renderListStore,
  renderRouter,
  storePathOf,
  vueGenerator,
} from '../src/index.js';

const CTX = { projectName: 'demo', outputRoot: '/tmp/out' };

async function renderPath(ir: IR, path: string): Promise<string> {
  const plan = vueGenerator.plan(ir, CTX).find((p) => p.path === path);
  if (plan === undefined) throw new Error(`未规划文件：${path}`);
  const file = await vueGenerator.render(plan, ir, CTX);
  return file.content;
}

describe('vueGenerator.plan', () => {
  it('总是产出工程骨架文件', () => {
    const { ir } = buildFixture();
    const paths = vueGenerator.plan(ir, CTX).map((p) => p.path);
    for (const required of [
      'package.json',
      'vite.config.ts',
      'tsconfig.json',
      'index.html',
      'src/main.ts',
      'src/App.vue',
      'src/router/index.ts',
      'src/api/client.ts',
      'src/api/types.gen.ts',
    ]) {
      expect(paths, missing(paths, required)).toContain(required);
    }
  });

  it('为每个页面规划组件文件，路径来自 suggestPath', () => {
    const { ir } = buildFixture();
    const plans = vueGenerator.plan(ir, CTX);
    expect(plans.find((p) => p.kind === 'page')?.path).toBe('src/views/devices.vue');
  });

  it('服务端分页的页面额外规划 store', () => {
    const { ir } = buildFixture();
    const plans = vueGenerator.plan(ir, CTX);
    expect(plans.find((p) => p.kind === 'store')?.path).toBe('src/stores/deviceList.ts');
  });

  it('同一模块下的多个接口只规划一个文件', () => {
    const { ir } = buildFixture();
    const modules = vueGenerator.plan(ir, CTX).filter((p) => p.path.startsWith('src/api/modules/'));
    expect(modules.map((p) => p.path)).toEqual(['src/api/modules/devices.ts']);
  });

  it('产物顺序稳定且不重复', () => {
    const { ir } = buildFixture();
    const first = vueGenerator.plan(ir, CTX).map((p) => p.path);
    const second = vueGenerator.plan(ir, CTX).map((p) => p.path);
    expect(second).toEqual(first);
    expect(new Set(first).size).toBe(first.length);
    expect([...first].sort()).toEqual(first);
  });

  it('工程骨架标记为不覆盖（never），避免冲掉用户改动', () => {
    const { ir } = buildFixture();
    const plans = vueGenerator.plan(ir, CTX);
    for (const path of ['package.json', 'vite.config.ts', 'tsconfig.json']) {
      expect(plans.find((p) => p.path === path)?.overwrite, path).toBe('never');
    }
  });
});

describe('页面组件渲染', () => {
  it('带生成标记头，含 IR 哈希与生成器版本', async () => {
    const { ir, listPage } = buildFixture();
    const content = await renderPath(ir, 'src/views/devices.vue');
    expect(content.startsWith('<!-- @dsg:generated')).toBe(true);
    expect(content).toContain('generator=vue@0.1.0');
    expect(content).toMatch(/ir=sha256:[0-9a-f]{64}/);
    expect(content).toContain(`node=${listPage.id}`);
  });

  it('搜索表单展开成表单项并带上枚举标签', async () => {
    const { ir } = buildFixture();
    const content = await renderPath(ir, 'src/views/devices.vue');
    expect(content).toContain('<el-form-item label="设备名称" prop="deviceName">');
    expect(content).toContain('<el-option label="在线" value="ACTIVE" />');
    expect(content).toContain('<el-option label="离线" value="OFFLINE" />');
  });

  it('表格列带上宽度与枚举着色', async () => {
    const { ir } = buildFixture();
    const content = await renderPath(ir, 'src/views/devices.vue');
    expect(content).toContain('prop="deviceId" label="设备编号" width="160"');
    expect(content).toContain("ACTIVE: '在线'");
  });

  it('分页时从 store 取 query 与 pagination', async () => {
    const { ir } = buildFixture();
    const content = await renderPath(ir, 'src/views/devices.vue');
    expect(content).toContain('const store = useDeviceListStore();');
    expect(content).toContain('const { pagination, query } = store;');
    expect(content).toContain('pagination.total = res.total;');
  });

  it('loadData 把分页与筛选条件拼成一个 params 对象', async () => {
    const { ir } = buildFixture();
    const content = await renderPath(ir, 'src/views/devices.vue');
    expect(content).toContain('page: pagination.page,');
    expect(content).toContain('pageSize: pagination.pageSize,');
    expect(content).toContain('deviceName: query.deviceName,');
    expect(content).toContain('} as ListDevicesParams;');
  });

  it('分页事件写回 store 后重新拉数', async () => {
    const { ir } = buildFixture();
    const content = await renderPath(ir, 'src/views/devices.vue');
    expect(content).toContain('pagination.page = page;');
    expect(content).toContain('pagination.pageSize = size;');
  });

  it('onMounted 时自动加载列表', async () => {
    const { ir } = buildFixture();
    const content = await renderPath(ir, 'src/views/devices.vue');
    expect(content).toContain('onMounted(() => {\n  void loadData();\n});');
  });

  it('同一个 IR 渲染两次结果完全一致', async () => {
    const { ir } = buildFixture();
    const a = await renderPath(ir, 'src/views/devices.vue');
    const b = await renderPath(ir, 'src/views/devices.vue');
    expect(b).toBe(a);
  });

  it('只改画布坐标不影响页面产物', async () => {
    const { ir, listPage } = buildFixture();
    const before = await renderPath(ir, 'src/views/devices.vue');
    listPage.position = { x: 9999, y: 9999 };
    const after = await renderPath(ir, 'src/views/devices.vue');
    expect(after).toBe(before);
  });

  it('页面脚本不产生未使用的 import', async () => {
    const { ir } = buildFixture();
    const content = await renderPath(ir, 'src/views/devices.vue');
    const imported = content.match(/^import \{ ([^}]+) \} from 'vue';$/m)?.[1];
    expect(imported).toBeDefined();
    for (const name of (imported ?? '').split(',').map((s) => s.trim())) {
      const uses = content.split(new RegExp(`\\b${name}\\b`, 'g')).length - 1;
      expect(uses, `${name} 只 import 未使用`).toBeGreaterThan(1);
    }
  });
});

describe('store 渲染', () => {
  it('初始化查询条件与分页，并提供重置', async () => {
    const { ir } = buildFixture();
    const content = await renderPath(ir, 'src/stores/deviceList.ts');
    expect(content).toContain("import { defineStore } from 'pinia';");
    expect(content).toContain("defineStore('deviceList'");
    expect(content).toContain('deviceName: undefined,');
    expect(content).toContain('const pagination = reactive({ page: 1, pageSize: 20, total: 0 });');
    expect(content).toContain('function resetQuery() {');
    expect(content).toContain('return { query, pagination, resetQuery };');
  });

  it('枚举字段的初始值取第一个枚举值', async () => {
    const { ir } = buildFixture();
    const content = await renderPath(ir, 'src/stores/deviceList.ts');
    expect(content).toContain("status: 'ACTIVE',");
  });

  it('store 文件带生成标记与文件头信息', async () => {
    const { ir } = buildFixture();
    const content = await renderPath(ir, 'src/stores/deviceList.ts');
    expect(content.startsWith('// @dsg:generated file=src/stores/deviceList.ts')).toBe(true);
  });
});

describe('路由与接口客户端', () => {
  it('路由表按页面生成懒加载项', async () => {
    const { ir } = buildFixture();
    const content = await renderPath(ir, 'src/router/index.ts');
    expect(content).toContain("path: '/devices'");
    expect(content).toContain("name: 'DeviceList'");
    expect(content).toContain("component: () => import('@/views/devices.vue')");
    expect(content).toContain("meta: { title: '设备列表' }");
  });

  it('接口模块按方法选择 params 还是 data', async () => {
    const { ir } = buildFixture();
    const content = await renderPath(ir, 'src/api/modules/devices.ts');
    expect(content).toContain("method: 'GET'");
    expect(content).toContain('params,');
    expect(content).toContain('return response.data;');
  });

  it('types.gen.ts 为列表接口生成 Item 与分页信封', async () => {
    const { ir } = buildFixture();
    const content = await renderPath(ir, 'src/api/types.gen.ts');
    expect(content).toContain('export interface ListDevicesItem {');
    expect(content).toContain('items: ListDevicesItem[];');
    expect(content).toContain('total: number;');
    expect(content).toContain('export interface ListDevicesParams {');
  });

  it('client.ts 留出鉴权注入挂载点', async () => {
    const { ir } = buildFixture();
    const content = await renderPath(ir, 'src/api/client.ts');
    expect(content).toContain('client.interceptors.request.use');
    expect(content).toContain('@dsg:todo 注入鉴权信息');
    expect(content).toContain('@dsg:todo 401 处理');
  });
});

describe('空 IR 与边界情况', () => {
  it('没有页面时仍产出骨架，路由表为空数组', async () => {
    const { ir } = buildFixture();
    // 节点是扁平的顶层数组，不在 canvas 里——清空时两者都要清
    ir.nodes = [];
    ir.edges = [];
    const paths = vueGenerator.plan(ir, CTX).map((p) => p.path);
    expect(paths).toContain('src/router/index.ts');
    expect(paths).not.toContain('src/views/devices.vue');
    expect(await renderPath(ir, 'src/router/index.ts')).toContain('const routes = [\n];');
  });

  it('未知路径渲染时报错而不是静默产出空文件', async () => {
    const { ir } = buildFixture();
    await expect(
      vueGenerator.render(
        { path: 'src/nope.ts', kind: 'config', sourceNodeIds: [], overwrite: 'always' },
        ir,
        CTX,
      ),
    ).rejects.toThrow(/无法渲染未知文件/);
  });
});

describe('路径推导', () => {
  it('apiModulePath 按路径首段归组', () => {
    const { ir } = buildFixture();
    const { pages } = { pages: [] as unknown[] };
    void pages;
    expect(apiModulePath({ operationId: 'x', method: 'GET', path: '/devices/{id}', responseShape: 'object', responseFields: [], requestFields: [], apiNodeId: '' })).toBe(
      'src/api/modules/devices.ts',
    );
    expect(apiModulePath({ operationId: 'y', method: 'GET', path: '/device-logs', responseShape: 'object', responseFields: [], requestFields: [], apiNodeId: '' })).toBe(
      'src/api/modules/deviceLogs.ts',
    );
    expect(ir.schemaVersion).toBe(1);
  });

  it('storePathOf 用组件名转驼峰', () => {
    const { listPage } = buildFixture();
    expect(storePathOf({ id: listPage.id, route: '/devices', title: '设备列表', componentName: 'DeviceList', layout: 'list', components: [], dataSources: [], suggestPath: 'src/views/devices.vue' })).toBe(
      'src/stores/deviceList.ts',
    );
  });
});

describe('渲染函数可直接调用', () => {
  it('renderRouter 空页面时产出空数组', () => {
    expect(renderRouter([], 'sha256:x')).toContain('const routes = [\n];');
  });

  it('renderApiTypes 对无接口的输入不产生多余类型', () => {
    const out = renderApiTypes([], 'sha256:x');
    expect(out).not.toContain('export interface');
  });

  it('阈值常量被搜索表单使用', () => {
    expect(INLINE_THRESHOLD).toBe(30);
    expect(GENERATOR_ID).toBe('vue');
  });
});

function missing(paths: string[], path: string): string {
  return `缺少文件 ${path}（实际产物：${paths.join(', ')}）`;
}

/**
 * 「生成物能过 tsc」的回归测试。
 *
 * 前面这些用例都发生在真装了 vue/element-plus 的临时项目里，代价太大不能
 * 每条都跑；但下面三个坑只要复发，用户就会拿到一个「生成成功、打开全是
 * 红色波浪线」的项目，而那时他已经在另一个仓库里，联想不到这边。
 */
describe('生成物可编译性（回归）', () => {
  it('types.gen.ts 不把接口字段写成 unknown（否则 v-model 全报 TS2322）', () => {
    const { ir } = buildFixture();
    const pages = emitUiSchema(ir).pages;
    const content = renderApiTypes(pages, 'sha256:x', emitUiSchema(ir).enums);
    // 索引签名 `[key: string]: unknown` 是允许的（兜住后端新增字段），
    // 但不允许把**具名字段**写成 unknown——那才是 v-model 报错的来源
    expect(content).not.toMatch(/^  \w+\?: unknown;/m);
    expect(content).toContain('deviceId?: string;');
    expect(content).toContain('deviceName?: string;');
  });

  it('types.gen.ts 带出枚举类型定义（否则下拉框失去类型约束）', () => {
    const { ir } = buildFixture();
    const { pages, enums } = emitUiSchema(ir);
    const content = renderApiTypes(pages, 'sha256:x', enums);
    expect(content).toContain('export type DeviceStatus =');
    expect(content).toContain("| 'ACTIVE'");
  });

  it('store 用类型别名声明 query，而不是 Record<string, unknown>', () => {
    const { ir } = buildFixture();
    const { pages } = emitUiSchema(ir);
    const page = pages.find((p) => p.components.some((c) => c.type === 'table' && c.pagination.mode === 'server'));
    expect(page).toBeDefined();
    const content = renderListStore(buildPageModelForTest(page!, 'sha256:x'));
    expect(content).toContain('type Query = {');
    expect(content).toContain('const initialQuery: Query = {');
    expect(content).not.toContain('Record<string, unknown>');
  });

  it('store 导入查询条件里引用到的枚举类型', () => {
    const { ir } = buildFixture();
    const { pages } = emitUiSchema(ir);
    const page = pages.find((p) => p.components.some((c) => c.type === 'table' && c.pagination.mode === 'server'));
    const content = renderListStore(buildPageModelForTest(page!, 'sha256:x'));
    expect(content).toContain("import type { DeviceStatus } from '@/api/types.gen';");
  });

  it('计划里包含 src/env.d.ts（缺了 import.meta.env 报 TS2339）', () => {
    const { ir } = buildFixture();
    const paths = vueGenerator.plan(ir, { projectName: 'Demo', outputRoot: '.' }).map((p) => p.path);
    expect(paths).toContain('src/env.d.ts');
  });

  it('env.d.ts 同时声明 vite/client 与 *.vue 模块', async () => {
    const { ir } = buildFixture();
    const content = await renderPath(ir, 'src/env.d.ts');
    expect(content).toContain('/// <reference types="vite/client" />');
    expect(content).toContain("declare module '*.vue'");
    expect(content).toContain('VITE_API_BASE_URL');
  });

  it('package.json 的 name 是合法 npm 包名（中文项目名会让 pnpm install 失败）', async () => {
    const { ir } = buildFixture();
    const plan = vueGenerator.plan(ir, { projectName: '设备管理', outputRoot: '.' }).find((p) => p.path === 'package.json');
    if (plan === undefined) throw new Error('未规划 package.json');
    const content = (await vueGenerator.render(plan, ir, { projectName: '设备管理', outputRoot: '.' })).content;
    const pkg = JSON.parse(content) as { name: string };
    expect(pkg.name).toMatch(/^[a-z0-9][a-z0-9._-]*$/);
  });
});
