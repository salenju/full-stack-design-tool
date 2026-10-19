# 技术设计 — 全栈全链路设计工具（Vue 3 / NestJS）

| 项 | 内容 |
|---|---|
| 文档编号 | TD-FSDT-1019 |
| 版本 | v0.2（7 项决策已确认） |
| 日期 | 2026-10-19 |
| 关联 | `PRD-全栈全链路设计工具-1019.md`、`BRD-全栈全链路设置工具-1019.md` |
| 决策状态 | 7 项产品决策已确认（见 1.2.1 与第 15 章） |
| 读者 | 实现者（单人/小团队） |

---

## 1. 设计目标与取舍

### 1.1 三条硬约束

1. **IR 是唯一真相源。** 所有产物（OpenAPI / UI Schema / 示例数据 / 代码 / AI 上下文）都是 IR 的**纯函数输出**，`f(IR, Options) → Artifact`。任何产物都不允许反向成为输入（逆编译除外，它是显式的独立通道）。
2. **编译管线不依赖网络。** 断网状态下，除「设计图导入」和「AI 填充」外全部可用，且产出完整可编译骨架。
3. **AI 是插件不是主干。** 生成器若调用 LLM，必须存在 `AI=off` 的等价路径；LLM 输出必须经白名单校验才能落盘。

### 1.2 关键取舍

| 决策 | 选择 | 备选 | 理由 |
|---|---|---|---|
| 画布引擎 | `@vue-flow/core@1.48.2` | tldraw（无官方 Vue 绑定）、AntV X6 v2、Plait | Vue 3 原生；handle/edge 模型天然支持字段级端口；X6 更偏图形编辑，Vue 集成需自写渲染层；tldraw 官方 Vue 模板成熟度不足 |
| 状态管理 | Pinia 4（`defineStore` + `immer` patch） | Zustand（React 生态）、自研 store | Vue 生态标准；配合 `immer` 做结构化 patch 便于撤销栈 |
| IR 校验 | Zod 4 schema + 手写语义校验 | 纯 TS 类型、JSON Schema | Zod 运行时可校验且能反推类型，一份定义两用 |
| OpenAPI 输出 | 手写 emitter（对象 → YAML） | `@asteasolutions/zod-to-openapi` | 需要精确控制 `$ref` 复用与示例注入；zod-to-openapi 对 example 与 nullable 控制较绕 |
| 前端模板 | Eta 4（TS 模板引擎） | Handlebars、字符串拼接、ts-morph | 生成的是「文本 + AST 混合」场景；Eta 快且类型友好；需要 AST 精修处再用 ts-morph |
| 后端框架 | NestJS 12 | Fastify 手写 | 用户指定；Nest 的模块化结构最容易被模板化 |
| 数据层 | Prisma（稳定版 7.x） | TypeORM | schema 文件是纯文本，生成成本最低；注意 npm `latest` 当前是 8.0.0-rc，需显式锁定稳定版 |
| 存储 | 双模式：**文件模式**（仓库内 `design/`，git 管理）+ **服务模式**（`~/.fsdt/` 项目目录 + SQLite 索引） | 全 SQLite、全文件 | IR 需可 diff、可 git 管理、可进 CI；快照与索引需要查询 |
| 运行形态 | 本地 NestJS 服务 + 浏览器 UI（`http://127.0.0.1:<port>`） | Electron/Tauri | 免打包、调试快；后续可套 Tauri 外壳 |
| 版本锁定 | Vue 3.5.x / TS 5.9.x / Vite 8.x / Node ≥22.12 | TS 7.x | `vue-tsc@3.3.13` peer 为 `typescript>=5.0.0`，但 TS 7 为原生重写版本，工具链生态尚未验证，**先用 5.9.3** |

### 1.2.1 已确认的产品决策（2026-10-19，不再作为待定项）

| # | 决策 | 对架构的约束 |
|---|---|---|
| 1 | 前端 UI 库**只做 Element Plus** | `generators/vue` 只维护一张 `ElementPlusMap`（FieldType → 组件）；`settings.frontend.uiLib` 保留联合类型以留扩展位，但只实现 `'element-plus'` 分支 |
| 2 | **不做 Options API 兼容** | 页面模板固定 `<script setup lang="ts">`；不引入 `defineComponent` 分支，模板量减半 |
| 3 | 数据层 **Prisma 7.x** 默认且显式锁定，保留 **TypeORM 适配位** | `settings.backend.orm: 'prisma' \| 'typeorm'`；`CodeGenerator` 按 orm 分发 `schema.prisma` / `*.entity.ts` 生成器，P1 只实现 prisma |
| 4 | **不生成 JWT 骨架** | 只生成 OpenAPI `securitySchemes`/`security`；后端 `main.ts` 与前端 `client.ts` 留全局 Guard / 拦截器挂载点（带注释）；新增 Lint 规则 L13（契约标了鉴权但项目 `backend.auth='none'` 时告警） |
| 5 | **需要画布反向导出** | 新增 `packages/exporter`：PNG/SVG（P0）、Mermaid/drawio/JSON（P1）；导出器是纯函数 `f(IR, CanvasView) → bytes`，与编译管线并列 |
| 6 | **本地服务 + 浏览器** | 无 Electron/Tauri；服务仅监听 `127.0.0.1`，端口可配置 |
| 7 | **需要 CLI** | 新增 `apps/cli`，命令直接调用 `packages/*`；IR 必须支持文件模式；退出码 0/1/2 约定 |

> **关于 BRD 中「Vue Flow 的 Vue 3 绑定标注为 alpha」的说法**：该判断已过期。实查 npm（2026-10-19），`@vue-flow/core` 的 `latest` 为 **1.48.2**，且已进入 1.x 主版本序列，配套包（background / controls / minimap / node-resizer / node-toolbar）均有 1.x 稳定版。本设计据此选型，但仍在渲染层做隔离（见 4.1），以便未来替换。

### 1.3 分层架构

```
┌─────────────────────────────────────────────────────────────┐
│  apps/web  (Vue 3.5 + Vite 8 + Element Plus 2.14 + Pinia 4)  │
│  画布视图 / 字段编辑 / 候选确认 / Lint 面板 / 生成预览        │
└───────────────┬─────────────────────────────────────────────┘
                │ HTTP (JSON) + SSE（生成进度）
┌───────────────▼─────────────────────────────────────────────┐
│  apps/server (NestJS 12)                                    │
│  ProjectService · ImportService · CompileService             │
│  GenerateService · AiService · LintService · SampleService   │
└───────────────┬─────────────────────────────────────────────┘
                │ 直接函数调用（同进程内库）
┌───────────────▼─────────────────────────────────────────────┐
│  packages/*  （纯 TS 库，零框架依赖，可单测）                 │
│  core-ir · compiler · generators · lint · sample · importer  │
│  · ai-context · shared                                       │
└─────────────────────────────────────────────────────────────┘
```

**关键点：所有编译/生成逻辑放在 `packages/*`，不放在 NestJS Controller 里。** 这样既能被服务调用，也能被 CLI 调用（CI 中做黄金样例测试），还能在未来搬到 Worker 线程。

---

## 2. 仓库结构（pnpm workspace）

```
full-stack-design-tool/
├── package.json                 # pnpm workspace root
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── vitest.workspace.ts
├── apps/
│   ├── web/                     # Vue 3 前端
│   │   ├── index.html
│   │   ├── vite.config.ts
│   │   └── src/
│   │       ├── main.ts
│   │       ├── App.vue
│   │       ├── router/index.ts
│   │       ├── stores/          # project / canvas / selection / lint / generation
│   │       ├── views/           # ProjectList / CanvasEditor / ImportWizard / GeneratePreview
│   │       ├── components/
│   │       │   ├── canvas/      # FlowCanvas / node-types / EdgeTypes / PortHandle
│   │       │   ├── inspector/   # FieldTable / FieldEditor / ConstraintForm
│   │       │   ├── import/      # CandidateTable / BboxOverlay
│   │       │   └── lint/        # LintPanel / LintRuleToggles
│   │       ├── composables/     # useUndoRedo / useAutosave / useHotkeys / useSse
│   │       └── api/             # 由本工具生成的前端请求客户端（不依赖外部 SDK 生成器）
│   └── server/                  # NestJS 12
│       └── src/
│           ├── main.ts
│           ├── app.module.ts
│           ├── modules/
│           │   ├── project/     ├── import/
│           │   ├── compile/     ├── generate/
│           │   ├── lint/        ├── sample/
│           │   └── ai/
│           └── common/          # guards / interceptors / sse
│   └── cli/                     # 命令行入口（不依赖 Nest，直接调 packages/*）
├── packages/
│   ├── core-ir/                 # IR 类型、Zod schema、ID、迁移、diff
│   ├── compiler/                # IR → OpenAPI / UI Schema / 中间模型
│   ├── generators/
│   │   ├── vue/                 # 前端生成器（模板 + 命名策略）
│   │   ├── nestjs/              # 后端生成器
│   │   └── runtime/             # 模板渲染、文件树、manifest、区块标记
│   ├── lint/
│   ├── sample/
│   ├── exporter/                # 画布反向导出：PNG/SVG（P0）、Mermaid/drawio/JSON（P1）
│   ├── importer/
│   │   ├── figma/               # REST 客户端 + 节点树 → 候选
│   │   └── vision/              # 图片通道（可插拔 provider）
│   ├── ai-context/
│   └── shared/                  # 通用工具、logger、错误类型
├── templates/
│   ├── vue/                     # .eta 模板
│   └── nestjs/
├── fixtures/                    # 黄金样例：IR → 期望产物
└── docs/
```

---

## 3. IR 设计（核心）

### 3.1 顶层结构

```ts
// packages/core-ir/src/types.ts
export interface IR {
  schemaVersion: 1;              // IR 结构版本，随不兼容变更递增
  project: ProjectMeta;
  canvases: Canvas[];
  nodes: IRNode[];               // 扁平存储，便于 diff 与索引
  edges: IREdge[];
  dictionaries: {                // 项目级可复用资产
    enums: EnumDef[];            // 命名枚举，多字段引用
    models: ModelDef[];          // 可复用的对象类型（如分页包装）
  };
  settings: ProjectSettings;
  meta: { createdAt: string; updatedAt: string; generator: string };
}
```

> 扁平数组 + ID 索引，而不是嵌套树：diff、三方合并、增量编译都以「按 ID 定位」为前提。

### 3.2 节点

```ts
export type NodeKind = 'table' | 'api' | 'page' | 'note';

interface NodeBase {
  id: string;                    // 'nd_' + nanoid(12)
  kind: NodeKind;
  name: string;                  // 显示名
  codeName: string;              // 代码标识（表=模型名，接口=operationId）
  canvasId: string;
  position: { x: number; y: number };
  size: { w: number; h: number };
  collapsed: boolean;            // 折叠后只显示前 5 个字段
  color?: string;
  tags: string[];
  notes?: string;
  locked?: boolean;
}

export interface TableNode extends NodeBase {
  kind: 'table';
  table: {
    dbName: string;              // snake_case，物理表名
    comment?: string;
    fields: Field[];             // 主键/唯一索引以 field 约束表达
    indexes: IndexDef[];
    softDelete: boolean;         // 是否生成 deletedAt
    timestamps: boolean;         // createdAt/updatedAt
  };
}

export interface ApiNode extends NodeBase {
  kind: 'api';
  api: {
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    path: string;                // '/devices/{id}'
    summary: string;
    description?: string;
    tags: string[];
    auth: 'none' | 'bearer' | 'apikey';
    deprecated?: boolean;
    pathParams: Field[];
    query: Field[];
    headers: Field[];
    requestBody?: BodyDef;
    responses: ResponseDef[];    // 至少一条
  };
}

export interface PageNode extends NodeBase {
  kind: 'page';
  page: {
    route: string;               // '/devices'
    title: string;
    layout: 'list' | 'form' | 'detail' | 'dashboard' | 'blank';
    components: PageComponent[];
  };
}

export interface NoteNode extends NodeBase {
  kind: 'note';
  note: { text: string; groupId?: string };
}
```

### 3.3 字段（一等实体）

```ts
export interface Field {
  id: string;                    // 'fd_' + nanoid(12)，永不复用
  name: string;                  // camelCase（API/前端）
  dbName?: string;               // snake_case（表），表节点内必填
  type: FieldType;
  comment?: string;              // 中文名/说明，用于生成注释与造数
  description?: string;
  required: boolean;
  nullable: boolean;
  readOnly?: boolean;
  writeOnly?: boolean;
  sensitive?: boolean;           // 造数掩码 + 上下文脱敏
  deprecated?: boolean;

  // 类型约束（按 type 生效，多余字段在 Lint 中告警）
  constraints?: {
    minLength?: number; maxLength?: number;
    minimum?: number; maximum?: number;
    pattern?: string;
    enumRef?: string;            // 指向 dictionaries.enums
    enumValues?: string[];       // 内联枚举
    default?: unknown;
    precision?: number; scale?: number;
    arrayItem?: FieldType;
    ref?: { tableId: string; fieldId?: string; onDelete?: 'restrict'|'cascade'|'setNull' };
  };

  example?: unknown;             // 显式示例，优先级高于生成
  locked?: boolean;              // 锁定示例值
  // 画布表现
  port?: { visible: boolean; order: number };
}

export type FieldType =
  | 'string' | 'text' | 'number' | 'integer' | 'boolean'
  | 'date' | 'datetime' | 'enum' | 'object' | 'array'
  | 'ref' | 'file' | 'json';
```

### 3.4 连线

```ts
export type EdgeKind = 'call' | 'read' | 'write' | 'map' | 'navigate';

export interface IREdge {
  id: string;                    // 'ed_' + nanoid(12)
  kind: EdgeKind;
  source: { nodeId: string; fieldId?: string; port?: 'out' };
  target: { nodeId: string; fieldId?: string; port?: 'in' };
  label?: string;
  // 仅 map 使用
  transform?: {
    fn: 'identity' | 'trim' | 'toNumber' | 'toString' | 'dateFormat' | 'lookup' | 'custom';
    args?: unknown[];
    expression?: string;         // fn=custom 时的受限表达式
  };
  // 仅 call 使用：页面动作触发
  trigger?: { componentId: string; event: 'click' | 'submit' | 'mount' | 'change' };
  // 仅 navigate 使用
  nav?: { params?: Record<string, string>; query?: Record<string, string> };
  canvasId: string;
}
```

**语义约束（由 Lint 执行）**

| kind | 合法 source | 合法 target |
|---|---|---|
| `call` | 页面组件的 action 端口 / 接口节点（链路串联） | 接口节点 |
| `read` | 接口 `responses[].fields` 端口 | 表字段 / 页面组件字段 |
| `write` | 接口 `requestBody` / `pathParams` / `query` 端口 | 表字段 |
| `map` | 任意字段端口 | 任意字段端口（类型需兼容或有 transform） |
| `navigate` | 页面节点 | 页面节点 |

### 3.5 页面组件（UI Schema 的直接输入）

```ts
export type PageComponent =
  | SearchFormComponent | TableComponent | FormComponent
  | DetailComponent | ActionComponent | TabsComponent | CardComponent;

interface ComponentBase {
  id: string;                    // 'cp_' + nanoid(12)
  type: string;
  title?: string;
  visibleWhen?: string;          // 受限表达式，如 'status === "ACTIVE"'
  bindings: FieldBinding[];
}

export interface FieldBinding {
  fieldRef: string;              // 指向 Field.id（不复制字段名）
  label?: string;                // 覆盖显示名
  control?: 'input'|'textarea'|'number'|'select'|'radio'|'checkbox'
           |'switch'|'date'|'datetime'|'upload'|'cascader'|'slot';
  span?: number;                 // 栅格宽度 1-24
  placeholder?: string;
  rules?: ValidationRule[];      // 额外校验，与字段约束合并
}

export interface SearchFormComponent extends ComponentBase {
  type: 'searchForm';
  inline: boolean;
  collapsible: boolean;
  apiRef: string;                // 提交后调用的接口节点 id
}

export interface TableComponent extends ComponentBase {
  type: 'table';
  apiRef: string;                // 数据源接口
  rowKeyFieldRef?: string;
  pagination: { mode: 'server'|'client'; pageSize: number };
  columns: Array<{ fieldRef: string; width?: number; align?: 'left'|'center'|'right';
                   sortable?: boolean; ellipsis?: boolean; formatter?: string }>;
  rowActions: ActionComponent[];
  selection: 'none' | 'single' | 'multiple';
}

export interface FormComponent extends ComponentBase {
  type: 'form';
  mode: 'create' | 'edit';
  apiRef: string;                // 提交接口
  loadApiRef?: string;           // 编辑时回显接口
  layout: 'horizontal' | 'vertical';
  submitText: string;
}

export interface ActionComponent extends ComponentBase {
  type: 'action';
  trigger: { event: 'click' | 'submit'; componentId?: string };
  apiRef?: string;
  navigateTo?: string;           // 页面路由
  confirm?: { text: string };
  level?: 'primary' | 'default' | 'danger';
}
```

### 3.6 设置

```ts
export interface ProjectSettings {
  frontend: {
    framework: 'vue';
    // 已确认：P0 只实现 element-plus，其余联合成员仅作扩展位（选择时生成器报 E_UNSUPPORTED）
    ui: 'element-plus' | 'naive-ui' | 'ant-design-vue';
    // 已确认：固定 script-setup，保留 'options' 仅为读取旧 IR 时的向前兼容
    apiStyle: 'script-setup' | 'options';
    packageManager: 'pnpm' | 'npm' | 'yarn';
    stateSolution: 'pinia';
    requestLib: 'axios' | 'ofetch';
    strictness: 'strict';
  };
  backend: {
    framework: 'nestjs';
    orm: 'prisma' | 'typeorm';       // P1 只实现 prisma；typeorm 走 CodeGenerator 适配器
    validation: 'class-validator';
    swagger: boolean;
    auth: 'none' | 'jwt';            // 已确认：P0 固定 'none'，只生成契约层 security 描述 + 挂载点
  };
  naming: {
    tableCase: 'snake' | 'camel';
    fieldCase: 'camel' | 'snake';
    pathCase: 'kebab' | 'snake';
    fileCase: 'kebab' | 'pascal';
  };
  generation: {
    outDir: string;
    sampleCount: number;
    sampleSeed: number;          // 默认项目级固定种子
    aiEnabled: boolean;
    aiProvider?: 'openai' | 'anthropic' | 'openai-compatible';
    aiModel?: string;
  };
  import: {
    candidateAutoAcceptThreshold: number;   // 默认 0.85
    candidateManualThreshold: number;       // 默认 0.5
    visionProvider?: 'openai-vision' | 'custom';
  };
  export: {                      // 已确认：需要画布反向导出
    image: 'png' | 'svg';
    structure: 'json' | 'mermaid' | 'drawio' | 'figma';
    includeFieldPorts: boolean;  // 导出图是否标注字段级端口，默认 false
  };
  lint: {
    enabled: boolean;
    blockOnError: boolean;
    ruleOverrides: Record<string, 'off' | 'info' | 'warn' | 'error'>;
    ignores: Array<{ ruleId: string; targetId: string; reason: string }>;
  };
}
```

### 3.7 画布与素材

```ts
export interface Canvas {
  id: string;
  name: string;                  // '设备管理'
  order: number;
  viewport: { x: number; y: number; zoom: number };
  background?: {
    assetId: string;             // 指向 assets/ 下的图片
    opacity: number;             // 0–1，默认 0.25（半透明铺底）
    locked: boolean;             // 锁定时不响应点击，避免挡住节点
    fit: 'contain' | 'width';
    offset: { x: number; y: number };
    scale: number;
  };
  grid: { enabled: boolean; size: number };
}

export interface Asset {
  id: string;                    // 'as_' + nanoid(12)
  kind: 'design' | 'screenshot' | 'figma-export';
  path: string;                  // 相对 assets/
  width: number; height: number;
  bytes: number;
  sha256: string;
  source?: { channel: 'figma'; fileKey: string; nodeId: string; fileVersion: string }
         | { channel: 'upload'; filename: string };
  createdAt: string;
}
```

> 设计稿铺底用的是 `background`（画布级、单张），而不是「图片节点」。理由：图片节点会被框选、参与连线、进 IR diff，是噪音；背景不进 Lint、不参与编译、不污染 `schemaHash`。若需要多张参考图，用 `note` 节点承载缩略图。

### 3.8 版本迁移

`packages/core-ir/src/migrations/` 存放 `v0 → v1` 的迁移函数数组。启动时若读到低版本 IR，自动迁移并备份原文件（`*.ir.backup.json`）。迁移函数必须有测试。

---

## 4. 前端设计（apps/web）

### 4.1 画布与 Vue Flow 的集成方式

**核心决策：Vue Flow 不持有业务状态。**

- Vue Flow 的 `nodes` / `edges` 由 `useCanvasStore` 的 computed 派生（`toFlowNodes(ir.nodes)`），**单向数据流**，Vue Flow 只负责渲染与交互事件。
- 节点拖拽结束 → 派发 `onNodeDragStop` → 写回 `ir.nodes[i].position`（经 undo 中间件）。
- 连线创建 → `onConnect` → 校验语义 → 创建 `IREdge`（同样进 undo 栈）。
- 这样「画布可整体替换」（未来换 React Flow/X6）只是换渲染层，IR 与逻辑不动。

### 4.2 字段端口实现

```vue
<!-- components/canvas/PortHandle.vue -->
<script setup lang="ts">
import { Handle, Position } from '@vue-flow/core'
import type { FieldType } from '@fsdt/core-ir'

const props = defineProps<{
  fieldId: string
  side: 'in' | 'out'
  kind: FieldType
  connected: boolean
}>()
</script>

<template>
  <Handle
    :type="props.side === 'in' ? 'target' : 'source'"
    :position="props.side === 'in' ? Position.Left : Position.Right"
    :id="`${props.side}:${props.fieldId}`"
    :class="['dsg-port', `dsg-port--${props.kind}`, { 'dsg-port--on': props.connected }]"
    :connectable="true"
  />
</template>
```

- `Handle` 的 `id` 编码为 `in:<fieldId>` / `out:<fieldId>`，连线时从 `connection.sourceHandle` 解析字段，**无需额外查表**。
- 节点默认折叠：只渲染前 5 个字段端口 + `+N` 徽标；「端口模式」开关打开后渲染全部（节点高度随字段数增长，超过 20 条内部滚动）。
- **大量字段的性能兜底**：一个节点超过 40 个字段时，端口改为「按需展开」（点击字段行后才出现 handle），避免 200 节点 × 40 handle 的 DOM 爆炸。

### 4.3 节点组件清单

| 组件 | 说明 |
|---|---|
| `TableNode.vue` | 表名 + 字段行（名/类型徽标/必填标记）+ 主键图标 |
| `ApiNode.vue` | method 色块 + path + 请求/响应分区折叠 |
| `PageNode.vue` | 路由 + 组件缩略列表（表单/表格图标） |
| `NoteNode.vue` | 富文本备注，支持分组背景 |

### 4.4 边组件

| 组件 | 样式 | 用途 |
|---|---|---|
| `CallEdge` | 实线 + 箭头 + 闪电图标 | 页面动作 → 接口 |
| `ReadEdge` | 蓝色虚线 | 响应 → 表/页面 |
| `WriteEdge` | 橙色实线 | 请求 → 表 |
| `MapEdge` | 细灰线 + 变换函数徽标 | 字段 → 字段 |
| `NavigateEdge` | 点线 + 箭头 | 页面 → 页面 |
| `FlowHighlightEdge` | 高亮流光动画 | 选中流程时 |

边样式通过 `edgeTypes` 注册，`data.kind` 决定渲染组件；非法连线（Lint 报错）叠加红色描边。

### 4.5 状态管理

```ts
// stores/project.ts
export const useProjectStore = defineStore('project', () => {
  const ir = ref<IR | null>(null)
  const dirty = ref(false)
  const undoStack = shallowRef<IR[]>([])
  const redoStack = shallowRef<IR[]>([])

  async function load(projectId: string) { /* GET /api/projects/:id */ }
  async function save() { /* PUT /api/projects/:id/ir，带 If-Match: schemaHash */ }

  // 所有变更统一入口，保证可撤销
  function mutate(fn: (draft: IR) => void) {
    const next = produce(ir.value!, fn)
    undoStack.value.push(ir.value!)
    if (undoStack.value.length > 100) undoStack.value.shift()
    redoStack.value = []
    ir.value = next
    dirty.value = true
  }

  function undo() {
    const prev = undoStack.value.pop()
    if (!prev) return
    redoStack.value.push(ir.value!)
    ir.value = prev
    dirty.value = true
  }

  function redo() {
    const next = redoStack.value.pop()
    if (!next) return
    undoStack.value.push(ir.value!)
    ir.value = next
    dirty.value = true
  }

  return { ir, dirty, load, save, mutate, undo, redo }
})
```

- **撤销粒度**：一次 `mutate` = 一步。拖拽结束后合并为一步（`onNodeDragStop` 才提交，拖动过程只改本地渲染坐标）。
- **自动保存**：`watch(dirty)` + 800ms 防抖 → `save()`；保存失败进入重试队列并在顶栏提示。

### 4.6 候选确认面板

- 三栏：来源预览（图片叠加 bbox / Figma 图层高亮）｜候选表格｜批量操作。
- 表格列为：勾选 / 名称（可编辑） / 类型（下拉） / 控件 / 置信度（进度条） / 来源 / 结论。
- 批量操作：全选高置信、全部采纳、按类型批量改、导出 CSV。
- 采纳后立即在画布上出现对应字段（可选「直接落到已有节点」或「新建节点」）。

---

## 5. 后端设计（apps/server, NestJS 12）

### 5.1 模块划分

| 模块 | 职责 | 依赖库 |
|---|---|---|
| `ProjectModule` | 项目 CRUD、IR 读写、快照、锁（`If-Match`） | `core-ir` |
| `ImportModule` | Figma 拉取、图片识别、候选合并 | `importer/*` |
| `CompileModule` | IR → OpenAPI / UI Schema，返回预览 | `compiler` |
| `GenerateModule` | 代码生成、manifest、三方合并、打包下载 | `generators/*` |
| `LintModule` | 规则执行、结果聚合 | `lint` |
| `SampleModule` | 示例数据、接口样例导出 | `sample` |
| `AiModule` | 上下文包组装、LLM 调用、输出校验 | `ai-context` |

### 5.2 存储布局（双模式）

**模式 A：服务模式（默认可视化使用）**

```
~/.fsdt/
├── index.sqlite                 # 项目索引、快照元数据、生成记录
└── projects/
    └── <projectId>/
        ├── project.json         # 项目元数据 + settings
        ├── canvases/<canvasId>.ir.json   # 按画布拆分 IR（大项目友好）
        ├── assets/              # 导入的设计图、截图
        ├── snapshots/<ts>.json  # 全量 IR 快照
        ├── imports/<jobId>.json # 导入任务与候选结果
        ├── output/              # 最近一次生成产物
        └── generations/<id>/    # 历史生成（manifest + 文件快照，可回滚）
```

**模式 B：文件模式（CLI / CI / git 协作）**

```
<repo>/
└── design/
    ├── project.json             # 与模式 A 同格式
    ├── ir.json                  # 单一 IR 文件（不按画布拆分，便于 diff 与评审）
    ├── generated.manifest.json  # 提交进仓库，作为漂移检测基线
    └── assets/
```

**两种模式的边界（必须遵守，否则会双写冲突）**

| 场景 | 权威存储 | 写入方式 |
|---|---|---|
| `fsdt gen --ir design/ir.json`（文件模式） | 仓库内文件 | CLI 直接读写文件，**不碰 `~/.fsdt/index.sqlite`** |
| `fsdt gen --server`（服务模式） | `~/.fsdt/` | CLI 通过 HTTP 调 `/api/*`，**不直接写盘** |
| 画布 UI 编辑 | 视项目来源而定 | 服务模式走 `PUT .../canvases/:id`；文件模式（`fsdt link`）下服务把变更写回仓库文件 |

> `fsdt link <path>` 把仓库内 `design/` 目录登记为某项目的权威存储，此后 UI 与 CLI 同时编辑同一份文件，靠 `If-Match` 哈希避免互相覆盖。

> **按画布拆分 IR 的理由**（仅服务模式）：避免单文件过大导致 diff 噪音；跨画布引用用 ID 全局唯一解决；保存时只写变动画布。文件模式刻意不拆分——CI 场景下单一文件更易评审与合并。

### 5.3 关键 API

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/projects` | 项目列表 |
| `POST` | `/api/projects` | 新建 |
| `GET` | `/api/projects/:id` | 元数据 + settings |
| `GET` | `/api/projects/:id/ir?canvas=all\|<id>` | 读 IR（合并视图） |
| `PUT` | `/api/projects/:id/canvases/:canvasId` | 写单画布 IR，`If-Match: <hash>` |
| `POST` | `/api/projects/:id/snapshots` | 建快照 |
| `POST` | `/api/projects/:id/snapshots/:sid/restore` | 回滚 |
| `POST` | `/api/projects/:id/import/figma` | body: `{ fileKey, nodeIds, token }` |
| `POST` | `/api/projects/:id/import/image` | multipart 上传 |
| `GET` | `/api/projects/:id/import/:jobId` | 任务状态 + 候选 |
| `POST` | `/api/projects/:id/import/:jobId/apply` | 应用候选到 IR |
| `POST` | `/api/projects/:id/lint` | 返回问题列表 |
| `POST` | `/api/projects/:id/compile` | 返回 `{ openapi, uiSchema, stats }` |
| `POST` | `/api/projects/:id/generate/preview` | 文件级 diff 预览 |
| `POST` | `/api/projects/:id/generate` | 执行生成（SSE 进度） |
| `GET` | `/api/projects/:id/generate/:gid/conflicts` | 三方合并数据 |
| `POST` | `/api/projects/:id/generate/:gid/resolve` | 提交合并决策 |
| `POST` | `/api/projects/:id/ai/fill` | 按流程填充业务逻辑（SSE 流式） |
| `GET` | `/api/projects/:id/download?gen=<gid>` | 下载 zip |

### 5.4 并发与一致性

- 写 IR 用 `If-Match: schemaHash`（乐观锁）；冲突返回 `409` + 服务端最新 hash，前端提示重新加载/覆盖。
- 长任务（导入、生成）建 `job` 记录，SSE 推进度事件：`job.created` / `job.progress` / `job.log` / `job.done` / `job.error`。
- 生成任务串行化：同一项目同一时刻只允许一个生成任务（项目级互斥锁，避免 manifest 竞争）。

---

## 6. 编译管线

### 6.1 总览

```
IR ──normalize──► IR'（补默认值、解析 enumRef、展开数组）
   ──validate───► Diagnostic[]（Zod + 语义）
   ──index──────► GraphIndex（邻接表、表→接口引用、字段→连线）
   ├──emitOpenApi──► OpenAPI 3.1 Document ─► YAML/JSON
   ├──emitUiSchema─► PageSchema[] + JSON Schema definitions
   ├──emitSample───► seed.json / fixtures.ts / *.http / postman.json
   ├──emitContext──► context/*.json（分片 + 预算）
   └──emitCode────► FileTree（前端 + 后端）──► 磁盘/zip
```

### 6.2 IR → OpenAPI 3.1

**映射规则**

| IR | OpenAPI |
|---|---|
| `TableNode` | `components.schemas.<PascalName>`（实体）+ `<PascalName>Create/Update` + `<PascalName>Page`（列表分页包装） |
| `ApiNode` | `paths.<path>.<method>` |
| `pathParams` | `parameters[in=path]`（`required: true`） |
| `query` | `parameters[in=query]`；列表接口若缺 `page/pageSize` 由 Lint 报错但不自动补 |
| `requestBody` | `requestBody.content['application/json'].schema` |
| `responses[]` | `responses[status].content[...]`，`description` 必填（缺省用 summary） |
| `Field.type` | `string/number/integer/boolean/object/array`；`date`→`string(format=date)`；`datetime`→`string(format=date-time)`；`enum`→`type:string + enum[]`；`ref`→`$ref` |
| `constraints` | `minLength/maxLength/minimum/maximum/pattern/default` |
| `required` | 父 schema 的 `required: string[]` |
| `sensitive` | `x-dsg-sensitive: true`（扩展字段，生成器与上下文包使用） |
| `TableNode.table.dbName` | `x-dsg-table: <dbName>` |
| `Edge(kind=map)` | 不直接进 OpenAPI；若两端都在同一 schema，写入 `x-dsg-mappings` |
| `ApiNode.api.auth` | `security` + `components.securitySchemes` |

**示例注入**：每个字段若 `example` 存在则写入；否则由 `sample` 包生成一个（与 seed 数据同种子，保证文档与数据一致）。

**校验**：输出后必须经 `@apidevtools/swagger-parser` 校验 3.1；失败视为编译器 bug（error 级），带 IR 节点 ID 报错。

**为什么 `DataFieldSchema` 必须带 `tsType` 而不是裸字段名**：只给 `prop` 的话，生成器
只能把接口类型写成 `{ deviceId?: unknown }`，于是 Vue 模板里每个 `<el-input v-model>` 都报
`TS2322: Type 'unknown' is not assignable to type 'string'`。用户拿到的是一个「生成成功、
用 IDE 打开满屏红波浪线」的项目，而这时他已经在另一个仓库里，联想不到是这里少了一个字段。
同理，`UiSchemaResult.enums` 要带出被引用到的枚举定义（`export type DeviceStatus = 'ACTIVE' | ...`），
否则下拉框的 v-model 会退化成 `string`，后端加了新枚举值前端也不会报错。

**`$ref` 复用策略**：同名同结构优先复用 `components.schemas`；结构不同但名同则追加数字后缀并记 warning（提示用户重命名）。列表响应统一包成 `{ items: T[], total: number, page: number, pageSize: number }`，命名为 `<Name>Page`。

### 6.3 IR → UI Schema

```ts
export interface PageSchema {
  id: string;                    // 页面节点 id
  route: string;
  title: string;
  layout: PageNode['page']['layout'];
  components: ComponentSchema[];
  dataSources: DataSourceSchema[];  // 该页面用到的接口（不存在时为空数组，不让 TS 报未定义类型）
  /** 生成器内部使用：文件建议路径 */
  suggestPath: string;              // 'src/views/devices/DeviceList.vue'
}

export interface DataFieldSchema {
  prop: string;
  /** 推导出的 TS 类型，如 string / number / DeviceStatus */
  tsType: string;
}

export interface DataSourceSchema {
  operationId: string;
  method: string;
  path: string;
  /** 响应体形状：list=信封 / object=单行 / raw=无固定结构 */
  responseShape: 'list' | 'object' | 'raw';
  dataKey?: string;    // list 形状下装数据的键，默认 items
  totalKey?: string;   // list 形状下装总数的键；无分页时不出现
  /** 该页面读到（渲染）的响应字段 */
  responseFields: DataFieldSchema[];
  /** 该页面用作请求参数（查询条件 / 表单提交）的字段 */
  requestFields: DataFieldSchema[];
  apiNodeId: string;
}

export interface ComponentSchema {
  id: string;
  type: PageComponent['type'];
  title?: string;
  api?: { operationId: string; method: string; path: string };
  columns?: Array<{ prop: string; label: string; width?: number; formatter?: string }>;
  fields?: Array<{
    prop: string; label: string; control: string;
    rules: Array<{ kind: 'required'|'min'|'max'|'pattern'|'enum'; value?: unknown }>;
    span?: number; placeholder?: string;
  }>;
  actions?: Array<{ id: string; label: string; api?: string; navigateTo?: string;
                    level?: string; confirm?: string }>;
  pagination?: { mode: 'server'|'client'; pageSize: number };
}
```

`prop` 取字段的 `name`（camelCase），并在生成时建立 `fieldId → prop` 映射，保证重命名后仍可追溯。

### 6.4 IR → 示例数据

**算法**

1. 建立表依赖图（`ref` 约束为边），拓扑排序；若成环 → 按环内「可空引用」断开（可空引用以 50% 概率置空），并记录 warning。
2. 对每表按拓扑序生成 N 条：
   - 主键：`auto` 类型 → 自增整数；否则按类型生成唯一值（计数器 + 前缀）。
   - `ref`：从被引用表已生成的行中随机取（尊重 `onDelete` 与 `nullable`）。
   - `enum`：按权重（可配置）取值，默认均匀。
   - `string`：按 `name` / `comment` 语义匹配语料（`姓名/手机号/邮箱/地址/公司/部门/状态`），未命中走 `lorem` + 长度约束。
   - `sensitive`：掩码（`138****1234`、`u***@example.com`）。
   - `pattern`：用 `randexp` 类策略反解析正则生成（失败则回退固定样例并 warning）。
3. 用同一 PRNG（`seed + tableName + rowIndex + fieldId` 派生）保证**确定性**与**局部稳定**（加字段不改变既有行的其他值）。

**输出**

| 文件 | 内容 |
|---|---|
| `seed.json` | `{ [tableDbName]: Row[] }` |
| `seed.sql` | 可选，INSERT 语句（含正确的插入顺序） |
| `fixtures.ts` | 前端 mock 用（`msw` handler 直接可用） |
| `api-samples.http` | 每接口一组请求（`.http` 格式，VS Code REST Client 可用） |
| `postman-collection.json` | 可选导出 |

**一致性校验**：生成后自检所有 `ref` 值是否存在；不通过则整体失败（不产出半成品）。

### 6.5 IR → AI 上下文包

**分片策略：按「流程（Flow）」切分。**

```ts
export interface Flow {
  id: string;
  name: string;                       // '设备列表查询'
  rootPageId: string;
  apiIds: string[];                   // 沿 call/read/write 边可达
  tableIds: string[];
  fieldIds: string[];
}
```

- 流程发现：从每个页面的 action 出发，沿 `call` → `read`/`write` 边做 BFS，得到闭包。
- 每片上下文包含：`flow` 元信息 + 相关 `PageSchema`（裁剪）+ 相关 `ApiNode`（完整）+ 引用到的表结构（只含被引用字段与主键）+ 类型系统说明 + **允许改动的文件清单** + `@dsg:todo` 位置列表。
- 预算控制：估算 token（`chars/2.2` 中文 + `chars/4` 英文的加权），超出则按「字段注释 → 示例值 → 非引用字段」顺序裁剪；仍超出则拆子流程（按接口粒度）。
- **不放入**：敏感字段值、其他流程的页面、`note` 节点、与流程无关的表。

---

## 7. 代码生成

### 7.1 生成器接口（适配器抽象）

```ts
export interface CodeGenerator {
  readonly id: string;                 // 'vue' | 'nestjs'
  readonly version: string;
  plan(ir: IR, ctx: CompileContext): FilePlan[];      // 决定要产出哪些文件
  render(plan: FilePlan, ir: IR, ctx: CompileContext): Promise<RenderedFile>;
}

export interface FilePlan {
  path: string;                        // 相对输出根
  kind: 'page' | 'component' | 'type' | 'client' | 'router'
      | 'module' | 'controller' | 'dto' | 'service' | 'schema' | 'config';
  sourceNodeIds: string[];             // 来源 IR 节点（用于 manifest 与增量）
  overwrite: 'always' | 'if-generated' | 'never';
}

export interface RenderedFile {
  path: string;
  content: string;
  language: 'ts' | 'vue' | 'prisma' | 'json' | 'css' | 'md';
  regions: Array<{ name: string; startLine: number; endLine: number;
                   mode: 'generated' | 'handwritten' | 'todo'; hash: string }>;
}
```

新增后端语言只需实现一个 `CodeGenerator`，编译管线与 UI 不变。

### 7.2 前端生成物（Vue 3）

```
output/frontend/
├── package.json                     # vue 3.5 / vite 8 / element-plus 2.14 / pinia 4 / vue-router 5 / axios
├── vite.config.ts                   # 含 /api 代理
├── tsconfig.json
├── index.html
├── env.d.ts
└── src/
    ├── main.ts
    ├── App.vue
    ├── router/index.ts              # 由页面节点生成
    ├── api/
    │   ├── types.gen.ts             # 由 OpenAPI schema 派生（entity/create/update/page）
    │   ├── client.ts                # axios 实例 + 拦截器（错误提示、token 注入）
    │   └── modules/<name>.ts        # 每接口一个函数，强类型
    ├── stores/<name>.ts             # 列表页的查询条件/分页状态（按需）
    ├── views/<module>/<Page>.vue    # 页面组件
    ├── components/                  # 生成的通用组件（SearchForm/DataTable/FormDialog）
    └── styles/tokens.css            # 设计 token（P2）
```

**页面模板策略（关键）**

- 每个页面 = 「区块骨架 + 字段驱动区块」：
  - `searchForm` → `<el-form :inline>` + 按 `fields[]` 循环渲染控件
  - `table` → `<el-table>` + 按 `columns[]` 渲染列 + 分页组件
  - `form` → `<el-form :model>` + 按 `fields[]` 渲染 + 校验规则
  - `action` → `<el-button>` + 二次确认 + 调用
- **循环渲染 vs 展开写死**：默认「展开写死」（生成可读、可改的显式代码），而不是运行时循环 schema。理由：用户需要改生成结果，显式代码比「解释器」更易改；仅在字段数 > 30 时切到循环模式（可配置）。
- 校验规则从字段约束 + `FieldBinding.rules` 合并生成 `el-form` 的 `rules` 对象。
- 所有生成文件头带标记：

```vue
<!-- @dsg:generated file=views/devices/DeviceList.vue node=nd_xxx ir=sha256:... -->
```

   并在 `script` 内待填位置留：

```ts
// @dsg:todo 实现设备导出逻辑（入参：查询条件；出参：Blob）
```

### 7.3 后端生成物（NestJS）

```
output/backend/
├── package.json
├── tsconfig.json
├── nest-cli.json
├── prisma/schema.prisma             # 由表节点生成
└── src/
    ├── main.ts                      # ValidationPipe、Swagger、CORS（含鉴权 Guard 挂载点）
    ├── app.module.ts
    ├── prisma/prisma.service.ts
    ├── common/                      # 分页 DTO、异常过滤器、响应包装
    └── modules/<name>/
        ├── <name>.module.ts
        ├── <name>.controller.ts     # 路由 + Swagger 装饰器 + DTO
        ├── <name>.service.ts        # 方法骨架 + @dsg:todo
        └── dto/
            ├── create-<name>.dto.ts # class-validator
            ├── update-<name>.dto.ts # PartialType
            └── query-<name>.dto.ts  # 分页 + 筛选
```

**认证：只留挂载点，不生成骨架**（已确认决策 4）

`main.ts` 的挂载点写成注释块，位置在 `ValidationPipe` 之后、路由注册之前：

```ts
// @dsg:todo 接入鉴权（本工具不生成 JWT 骨架）
// app.useGlobalGuards(new JwtAuthGuard(reflector));
// 若使用公司 SSO / 网关鉴权，在此替换为实现了 CanActivate 的 Guard。
// 注意：登录路由必须用 @Public() 之类机制反向放行，否则会死循环。
```

前端 `client.ts` 同理：

```ts
// @dsg:todo 注入鉴权信息
// client.interceptors.request.use((c) => {
//   const t = useAuth().token;
//   if (t) c.headers.Authorization = `Bearer ${t}`;
//   return c;
// });
```

只留挂载点的理由：本工具面向已有认证体系的全栈工程师，强行塞入 opinionated JWT（token 存哪里、refresh 竞态、登出语义）反而增加拆除成本，存量项目（场景 C）会被污染。但**契约层的 `securitySchemes` 仍完整生成**，保证 OpenAPI 不撒谎。

**Prisma 映射**

| IR | Prisma |
|---|---|
| `TableNode.table.dbName` | `model <Pascal> { @@map("<dbName>") }` |
| `field.dbName` | `@map("<dbName>")` |
| `integer` + pk | `Int @id @default(autoincrement())` |
| `ref` | `@relation(fields:[xId], references:[id], onDelete: ...)` |
| `enum` | `enum <Name> { ... }` |
| `timestamps` | `createdAt DateTime @default(now())` / `updatedAt DateTime @updatedAt` |
| `softDelete` | `deletedAt DateTime?` |

**Prisma 7 的连接串位置（实现时踩到的坑）**：Prisma 7 起 `datasource.url` 不再允许写在
`schema.prisma` 里，否则任何 `prisma generate` / `migrate` 都直接报 `P1012: The datasource
property url is no longer supported`。因此生成器必须**同时**产出 `prisma.config.ts`：

```ts
import { defineConfig, env } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: { url: env('DATABASE_URL') },
});
```

`schema.prisma` 里只留 `datasource db { provider = "postgresql" }`。只产 schema 会让用户
拿到的项目第一步就失败，而且报错指向 schema 第 10 行——完全看不出是「Prisma 版本变了」。

**Service 骨架**

```ts
@Injectable()
export class DeviceService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: QueryDeviceDto) {
    // @dsg:todo 实现分页查询（使用 query.page/query.pageSize 与筛选条件）
    throw new NotImplementedException('list');
  }
}
```

`throw new NotImplementedException` 是刻意的：**未实现必须显式失败**，而不是返回假数据让人误以为通了。

### 7.4 文件归属与区块标记

```ts
/** @dsg:generated start name=columns hash=abc123 */
const columns = [...]
/** @dsg:generated end name=columns */
```

- `mode=generated`：重新生成直接替换（哈希不一致时进入冲突流程）。
- `mode=handwritten`：永不覆盖，即使 node 变更；只提示「契约已变，请人工检查」。
- `mode=todo`：仅替换 `@dsg:todo` 行（或其标记块），AI 填充写入此处。
- 无标记的整个文件：按 `overwrite` 策略处理（`never` 时只提示差异不写入）。

### 7.5 manifest 与增量

```json
{
  "generationId": "gen_xxx",
  "schemaHash": "sha256:...",
  "createdAt": "2026-10-19T12:00:00Z",
  "generator": { "vue": "1.0.0", "nestjs": "1.0.0" },
  "files": [
    { "path": "src/views/devices/DeviceList.vue", "hash": "sha256:...",
      "sourceNodeIds": ["nd_page1"], "regions": [{ "name": "columns", "hash": "..." }] }
  ]
}
```

- 增量生成：对比新 `FilePlan` 与旧 manifest，只重渲染 `sourceNodeIds` 或其依赖字段发生变化的文件。
- 依赖追踪：页面依赖接口与表；表字段改名 → 页面 + 类型 + DTO 全部标记为受影响。

---

## 8. 设计图导入子系统

### 8.1 统一抽象

```ts
export interface CandidateExtractor {
  readonly channel: 'figma' | 'vision';
  extract(input: ExtractorInput, ctx: ExtractorContext): Promise<ExtractionResult>;
}

export interface FieldCandidate {
  id: string;
  name: string;                        // 原始建议名（可能为中文）
  normalizedName?: string;             // camelCase 建议
  label?: string;
  type: FieldType;
  control: FieldBinding['control'];
  confidence: number;                  // 0..1
  evidence: Array<{
    kind: 'text' | 'layerName' | 'component' | 'placeholder' | 'bbox' | 'inferred';
    value: string;
    bbox?: { x: number; y: number; w: number; h: number };
    nodePath?: string;                 // Figma 节点路径
  }>;
  group?: { id: string; label: string; role: 'search'|'table'|'form'|'detail' };
  decision: 'pending' | 'accepted' | 'renamed' | 'retyped' | 'rejected';
}

export interface ExtractionResult {
  candidates: FieldCandidate[];
  groups: Array<{ id: string; label: string; role: string; bbox?: BBox }>;
  pages: Array<{ name: string; bbox?: BBox; suggestedRoute: string }>;
  raw?: unknown;                       // 原始响应，存 imports/<jobId>.json 便于复查
  warnings: string[];
}
```

### 8.2 Figma 通道

```
POST https://api.figma.com/v1/files/:key/nodes?ids=<id1,id2>&depth=...
Header: X-Figma-Token: <PAT>
```

**提取规则（按优先级打分）**

| 证据 | 规则 | 权重 |
|---|---|---|
| 文本图层 | 形如 `名称`、`设备名称`、`请输入设备名称`，识别为字段标签 | 0.9 |
| 图层名 | `Input/DeviceName`、`FormItem/status`、`TableColumn/sn` | 0.85 |
| 组件实例名 | `Input`、`Select`、`DatePicker`、`Switch`、`Upload` 映射控件类型 | 0.8 |
| Placeholder | `请输入` / `请选择` 前缀判定控件（输入/选择） | 0.75 |
| Frame/Group 名 | `搜索区` `表格` `表单` `弹窗` 判定 group role | 0.7 |
| 位置与尺寸 | 同 Y 轴成组、等宽列 → 推断表格列；顶部横幅 → 搜索区 | 0.6 |
| 类型推断 | 名称含「时间/日期」→ datetime；「数量/金额/数」→ number；「是否/启用」→ boolean；「状态」→ enum | 0.65 |

**名称规范化**：中文名 → 拼音首字母? **不**。策略是：优先用英文图层名转 camelCase；无英文则用中文名作为 `label`，`name` 由用户确认时生成（`field1`、`field2` 兜底并提示）。这是刻意避免「拼音字段」这种反模式。

**去重合并**：以 `bbox 近似重叠 + 名称相似（编辑距离 ≤2）+ 类型相同` 为合并条件，合并后 `confidence = max`，`evidence` 取并集。

**限流与缓存**：节点树按 `fileKey + nodeId + fileVersion` 缓存到 `assets/figma-cache/`；命中缓存直接复用，避免重复请求触发限流。

### 8.3 图片通道

```
图片 ─► 预处理（缩放至长边 ≤2048，压缩至 ≤2MB）
     ─► 视觉模型（结构化输出 / JSON mode）
     ─► 校验（Zod schema）
     ─► 与 OCR 文本层交叉验证（可选）
     ─► FieldCandidate[]
```

**提示词要点（结构化输出契约）**

- 输入：图片 + 「输出 JSON：`{ pages, groups, candidates[] }`，每项含 `name/label/type/control/confidence/bbox`」。
- 强约束：`bbox` 使用归一化坐标（0–1）；不确定的字段给 `confidence < 0.5`；**禁止编造图片中不存在的字段**。
- `type` 必须来自闭集；`control` 必须来自闭集。
- 失败重试：Zod 校验失败 → 附带错误信息重试 1 次；仍失败则降级为「仅文本列表、无 bbox」。

**图片通道的确定性补充**：模型调用不确定，但**应用候选后的 IR 是确定的**。因此导入任务记录 `provider/model/promptVersion`，便于复现与对比。

### 8.4 候选确认 → IR 的应用流程

```
POST /import/:jobId/apply
body: { decisions: [{ candidateId, action, overrides? }], target: { mode:'existing'|'new', nodeId? } }

服务端：
1. 校验 decisions 覆盖所有 pending（或显式 skip）
2. 建/取目标节点 → 分配 fieldId（新 ID，不复用）
3. 写入 Field（含 label→comment、control→binding）
4. 建立 PageComponent 与 FieldBinding（若 group.role 已知）
5. 返回 patch + 新 schemaHash
前端：把 patch 合入 store（作为一步 undo）
```

**幂等**：同一 job 重复 apply 不会产生重复字段（以 `candidateId → fieldId` 映射表判重）。

---

## 9. Lint 引擎

```ts
export interface LintRule {
  id: string;                          // 'L001'
  defaultSeverity: 'info' | 'warn' | 'error';
  description: string;
  run(ctx: LintContext): LintIssue[];
}

export interface LintIssue {
  ruleId: string;
  severity: 'info' | 'warn' | 'error';
  message: string;
  target: { nodeId?: string; fieldId?: string; edgeId?: string; componentId?: string };
  fix?: { kind: 'setType'|'addField'|'addBinding'|'rename'; payload: unknown };  // 可选自动修复
}
```

- 规则以数组注册，`settings.lint.ruleOverrides` 覆盖严重度，`ignores` 精确忽略（规则 + 目标 ID + 理由）。
- **可自动修复**的规则（L006 重复路径、L012 路由冲突、L008 缺枚举）提供「一键修复」按钮。
- 执行时机：IR 变更后 300ms 防抖跑一次（前端增量，只跑受影响节点相关规则）；生成前全量跑一次（服务端，作为门禁）。

**增量 Lint**：`GraphIndex` 维护「字段 → 引用它的接口/页面」反向索引，字段变更只重跑引用链上的规则，避免大图卡顿。

---

## 10. AI 填充设计

### 10.1 流程

```
1. 选择流程（或「全部流程」自动排队）
2. 组装上下文包（分片）
3. 选择待填 @dsg:todo 清单（来自 manifest）
4. 调用 LLM（streaming，JSON 结构化输出）
5. Zod 校验输出 → 白名单校验（仅允许已存在的文件/方法/字段）
6. 沙箱写入（临时目录）+ tsc/vue-tsc 检查
7. 通过 → 落盘并更新 manifest；失败 → 回滚 + 报告（附编译错误）
```

### 10.2 输出格式（强约束）

```json
{
  "flowId": "flow_devices_list",
  "edits": [
    {
      "file": "src/modules/device/device.service.ts",
      "todoId": "todo_7f3a",
      "replacement": "async list(query: QueryDeviceDto) { ... }",
      "explanation": "分页查询，按 createdAt 倒序"
    }
  ],
  "notes": ["需要在 Prisma schema 中确认 device.sn 唯一索引"]
}
```

**白名单校验**：`file` 必须在本次 `FilePlan` 内；`todoId` 必须存在于该文件；`replacement` 不得引入新的装饰器路由（对 controller 文件做 AST 检查：`@Get/@Post/...` 路径集合必须与 IR 一致）。

### 10.3 降级路径

- 无 API key / 断网 / 超时 → 保留 `@dsg:todo`，生成 `AI-TODO.md` 清单（人可照单实现），**生成流程整体仍算成功**。
- 模型输出多次失败 → 记录失败原因，不阻塞其他流程。

---

## 11. 往返与冲突处理

### 11.1 冲突判定

```
对每个待写文件：
  oldManifest = 上次生成记录中的该文件哈希
  currentFile = 磁盘现有内容哈希
  newContent  = 本次生成内容哈希

  if 文件不存在                        → 新增
  else if currentFile == oldManifest   → 无人工改动，直接覆盖
  else if currentFile == newContent    → 内容相同，跳过
  else                                 → 冲突，进入三方合并
```

### 11.2 三方合并粒度

按 `@dsg:generated` 区块合并（而非整文件 diff）：区块内哈希比对，区块外的用户代码原样保留。整文件级 diff 仅用于「无区块标记」的旧文件。

UI 呈现：左（上次生成）/ 中（当前文件，可编辑）/ 右（本次生成），逐块选择。合并后立即跑类型检查，失败则不允许保存。

### 11.3 契约变更提示

`generation.schemaHash` 与当前 IR 哈希不同时，顶部提示，并给出**变更摘要**（来自 `core-ir` 的 `diff(irA, irB)`）：新增/删除/改名的节点与字段、受影响的文件数。这是「重新生成前用户最想知道的信息」。

---

## 12. 测试策略

| 层级 | 工具 | 覆盖 |
|---|---|---|
| 单元 | Vitest 5 | IR schema、编译器映射、命名策略、PRNG 确定性、Lint 规则（每规则至少 1 正 1 反） |
| 黄金样例 | Vitest + `fixtures/` | `fixtures/ir/*.json` → 期望产物快照（OpenAPI/UI Schema/文件树）；diff 即失败 |
| 契约校验 | `swagger-parser` | 所有 fixture 产出的 OpenAPI 必须合法 3.1 |
| 生成物编译 | 子进程 `tsc --noEmit` / `vue-tsc --noEmit` | 对生成的前端/后端各跑一次（CI 中，慢但必要） |
| 集成 | Supertest + 临时目录 | 项目 CRUD → 导入 → 编译 → 生成 → 下载 全链路 |
| E2E | Playwright 1.64 | 场景 A 全流程（含拖拽连线、候选确认）；场景 D 冲突合并 |
| 视觉回归 | Playwright 截图 | 画布关键状态（可选，P1） |

**确定性要求**：所有生成器禁止使用 `Date.now()` / `Math.random()` 直接输出；时间与随机必须来自 `CompileContext`（注入 `now` 与 `rng`），否则黄金样例永远不稳定。

---

## 12.1 文档与产物一致性守则

为避免「设计文档与生成物漂移」，以下检查进入 CI：

| 检查 | 内容 |
|---|---|
| fixture 完整性 | `fixtures/ir/*.json` 每个都必须有对应的期望产物目录；新增 IR 未补期望即失败 |
| OpenAPI 合法性 | 所有 fixture 产物经 `swagger-parser` 校验 |
| 生成物可编译 | 对 fixture 产物跑 `vue-tsc --noEmit` 与 `tsc --noEmit` |
| manifest 一致 | 生成文件的哈希与 manifest 记录一致；无未登记文件 |
| Lint 规则覆盖 | 每个规则至少 1 个正例与 1 个反例 fixture |
| 文档锚点 | 本文件与 PRD 中的章节交叉引用（如「见 6.5.1」）必须可解析 |

> 之所以单列此节：代码生成类工具最常见的失败方式不是「写错」，而是「文档说的和生成器做的不一样」。这道闸门是让 PRD/TD 保持可执行的最低成本手段。

---

## 13. 性能设计

| 场景 | 目标 | 手段 |
|---|---|---|
| 200 节点拖拽 | ≥50fps | Vue Flow `onlyRenderVisibleElements`；节点 `shallowRef`；拖动中只改 CSS transform，松手才写 store |
| 大量字段端口 | 不卡死 | 折叠默认只渲染 5 个；>40 字段按需展开；`v-memo` 字段行 |
| IR 编译 1000 字段 | ≤3s | 单遍构建 `GraphIndex`；`$ref` 缓存；不做重复深拷贝 |
| 增量生成 | 只渲染受影响文件 | manifest 哈希 + 反向依赖索引 |
| 示例数据 1000 行 × 10 表 | ≤5s | 流式生成 + 分批写文件；引用查找用索引而非线性扫描 |

---

## 14. 安全设计

- Figma PAT / AI Key：仅存本地（`~/.fsdt/secrets.json`，权限 0600；或系统 keychain），**绝不写入项目包与导出的 zip**。
- 项目包导出时剔除 `secrets.json` 与缓存目录。
- 视觉识别上传前提示：图片将发送至配置的模型服务（可关闭）。
- 敏感字段：`sensitive: true` → 示例数据掩码、上下文包剔除值、OpenAPI 标记扩展。
- 生成器禁止执行用户提供的任意脚本；`transform.fn=custom` 的表达式在受限解释器中求值（白名单函数 + 无副作用），不 `eval` 任意代码。
- 服务仅监听 `127.0.0.1`，不对外暴露；CORS 白名单为本地 UI 端口。

---

## 15. 已确认决策（原「待确认」）

| # | 问题 | **决策** | 落地影响 |
|---|---|---|---|
| 1 | UI 库是否只用 Element Plus？ | **只做 Element Plus** | 前端生成器维护单一组件映射表；其它 uiLib 值选择时报 `E_UNSUPPORTED` |
| 2 | 是否需要 Options API 兼容？ | **不做** | 页面模板只有 `<script setup lang="ts">` 一种形态 |
| 3 | Prisma 是否有硬需求换 TypeORM？ | **Prisma 7.x 为默认并显式锁定**；保留 TypeORM 适配位 | 依赖版本写死 `prisma@7.x`（禁用 `^`，因 npm latest 为 8.0.0-rc）；`settings.backend.orm` 决定分发哪个 schema 生成器 |
| 4 | 是否需要内置 JWT 认证骨架？ | **不做** | 只生成 OpenAPI `securitySchemes`/`security`；`main.ts` 留全局 Guard 挂载点注释，`client.ts` 留请求拦截器 token 注入位；新增 Lint L013 |
| 5 | 是否需要画布反向导出？ | **需要** | 新增 `packages/exporter`（第 17 章）：P0 出 PNG/SVG，P1 出 Mermaid/drawio/结构化 JSON 与 Figma 可消费格式 |
| 6 | 交付形态 | **本地服务 + 浏览器** | 无 Electron/Tauri；仅监听 `127.0.0.1` |
| 7 | 是否需要 CLI？ | **需要** | 新增 `apps/cli`（第 16 章）；IR 支持文件模式；退出码 0/1/2 |

---

## 16. CLI 与 CI 集成

### 16.1 为什么 CLI 是架构约束而非附属功能

`packages/*` 从第 1 章起就规定「编译/生成逻辑不放 Controller」，这条纪律的回报就是 CLI：**同一个 `packages/compiler` 既能被 NestJS 调用，也能被 `apps/cli` 调用，还能被 CI 直接执行。**

CLI 真正的价值不是「多一个入口」，而是三件事：

1. **漂移门禁**：`fsdt gen --check` 让「改了契约没重新生成」在 CI 里变成红灯。技术设计 7.5 的 manifest 哈希，其首要用途就是漂移检测，而非增量生成。
2. **无 UI 全链路**：设计师交付截图 → `fsdt import image --apply` → `fsdt gen`，全程不启浏览器。
3. **AI agent 工具面**：`fsdt compile --stdout json` 就是一次工具调用，Claude Code / Cursor 等可直接使用，**无需先实现 MCP 协议**（MCP 可后续薄封装在 CLI 之上）。

### 16.2 命令表

```
fsdt init                                   # 在仓库内初始化 design/（文件模式）
fsdt serve [--port 61923] [--open]          # 本地服务 + 浏览器
fsdt link <path>                            # 把仓库内 design/ 登记为项目权威存储
fsdt import figma --file <key> --node <id>... [--apply]
fsdt import image --file <png> [--apply]
fsdt lint [--format text|json|sarif] [--changed] [--fail-on error|warn]
fsdt compile [--out openapi.yaml] [--ui-schema] [--stdout json]
fsdt gen [--target vue,nestjs] [--out ./] [--check] [--force]
fsdt sample [--seed 42] [--count 20] [--out ./mocks]
fsdt export [--format png|svg|mermaid|drawio|json] [--canvas <id>] [--out ./]
fsdt ai fill [--todo] [--dry-run]
fsdt diff [--from <git-ref>]                # IR 语义 diff（不是文本 diff）
```

### 16.3 三条纪律

1. **默认只读**：`gen` 不带 `--out` 只做预览；写文件必须显式指定。
2. **确定性**：凡是能进 CI 的命令，输出必须字节级可复现（依赖 `sample.seed` 与稳定的键排序）。
3. **`--check` 与 `--out` 互斥**：前者只报告差异，不写盘。

### 16.4 退出码

| 码 | 含义 |
|---|---|
| `0` | 成功（含 `--check` 无差异） |
| `1` | 校验失败或存在差异（lint error / 生成物与已提交文件不一致） |
| `2` | 用法错误（参数非法、IR 文件不存在、schema 版本不支持） |

### 16.5 文件模式与服务模式的边界

见 5.2。核心规则：**同一项目同一时刻只有一个权威存储**。文件模式下 CLI 直接读写 IR 文件、不碰 SQLite 索引；服务模式下 CLI 走 HTTP、不直接写盘。二者混用会导致 IR 与 manifest 不同步。

### 16.6 密钥策略

| 密钥 | 来源 | 禁止 |
|---|---|---|
| Figma Token | `FSDT_FIGMA_TOKEN` 环境变量 | 写入 `project.json` / IR / 提交进仓库 |
| LLM API Key | `FSDT_LLM_API_KEY` | 同上 |
| 视觉模型 Key | `FSDT_VISION_API_KEY` | 同上 |

`settings` 只记录「用哪个 provider / model」，不记录任何凭据。项目包在 `fsdt export` 与下载 zip 前做一次密钥扫描（正则匹配常见 token 前缀），命中即报警并阻断。

### 16.7 CI 集成示例

```yaml
# .github/workflows/design-drift.yml
- run: pnpm fsdt lint --format sarif > lint.sarif
- uses: github/codeql-action/upload-sarif@v3
  with: { sarif_file: lint.sarif }
- run: pnpm fsdt gen --check        # 契约改了却没重新生成 → 红灯
```

---

## 17. 画布反向导出（packages/exporter）

### 17.1 定位

导出器与编译管线并列，同属「`f(IR) → 产物`」的纯函数：

```
IR + CanvasView ──► buildExportModel ──► png / svg / mermaid / drawio / json
```

**不依赖 Vue Flow 实例**：从 IR 重建几何（节点 `position`/`size`，边的 `source/target`），因此可在 Node 环境（CLI、CI）中运行，无需浏览器。

### 17.2 接口

```ts
export interface CanvasExporter {
  readonly id: 'png' | 'svg' | 'mermaid' | 'drawio' | 'json' | 'figma';
  readonly requiresBrowser: boolean;   // png 需要光栅化（见 17.4）
  export(ir: IR, canvasId: string, opts: ExportOptions): Promise<ExportResult>;
}

export interface ExportOptions {
  includeFieldPorts: boolean;   // 是否在节点上标注字段级端口，默认 false（避免拥挤）
  includeNotes: boolean;
  theme: 'light' | 'dark';
  scale: number;                // png 缩放，默认 2
  padding: number;
}
```

### 17.3 各格式实现要点

| 格式 | 实现 | 阶段 |
|---|---|---|
| `svg` | 纯字符串拼装：节点矩形 + 文本 + 折线（正交路由复用第 4 章的边路由函数），字体用 `font-family` 而非嵌入 | P0 |
| `png` | 由 `svg` 经 `@resvg/resvg-js`（纯 Rust 无浏览器依赖）光栅化 | P0 |
| `json` | IR 子集 + 布局信息，供外部工具还原 | P0 |
| `mermaid` | `flowchart LR`：节点 `n1["设备表"]`，边按 kind 用不同箭头（`-->` call、`-.->` read、`==>` write、`--o` navigate） | P1 |
| `drawio` | 未压缩 XML（`<mxGraphModel>`），坐标直接用 IR 的 `position` | P1 |
| `figma` | 生成 Figma Plugin API 可执行的 JS 脚本（用户粘进 Figma 运行），而非直接调 API（避免权限与限流） | P1 |

### 17.4 为什么 PNG 不用浏览器截图

浏览器截图（Puppeteer）会带来数百 MB 依赖与 CI 环境问题，而本工具的图形元素极其简单（矩形、文本、折线）。**用 SVG 字符串 + `@resvg/resvg-js` 光栅化**即可，无头依赖、可跑在任意 Node 环境。

### 17.5 与 Lint/编译的关系

导出器**只读不写 IR**，不参与 Lint 门禁，也不影响 `schemaHash`。画布的 `background`（设计图铺底）默认**不**导出，除非 `includeNotes` 类选项显式开启——避免把设计稿原图带进对外评审图。

---

## 18. 实施顺序（可直接转成任务）

| 阶段 | 任务 | 产出/验收 |
|---|---|---|
| 1 | 仓库初始化：pnpm workspace、tsconfig、vitest、lint、CI | `pnpm -r build` 通过 |
| 2 | `core-ir`：类型 + Zod + ID + 迁移骨架 + 单测 | schema 测试全绿 |
| 3 | `apps/web` 壳：路由、布局、项目列表、Pinia | 能建项目 |
| 4 | 画布：Vue Flow 集成、四类节点、字段编辑、端口、五类边 | 能画出场景 A 的图并保存 |
| 5 | 撤销/重做 + 自动保存 + 快照 | 刷新不丢数据，可回滚 |
| 6 | `compiler`：normalize/validate/index + OpenAPI emitter | 导出合法 3.1 |
| 7 | `compiler`：UI Schema emitter + 前端生成器 | `vue-tsc` 通过 |
| 8 | `lint`：14 条规则 + 面板 + 门禁 | 缺陷注入检出率达标 |
| 9 | `sample`：确定性造数 + 引用完整性 + 导出 | 两次生成字节一致 |
| 10 | `importer/figma` | 真实文件能出候选 |
| 11 | 候选确认面板 + apply 流程 | 场景 A 步骤 2–5 跑通 |
| 12 | `generators/nestjs` | `nest build` 通过 |
| 13 | `importer/vision` | 截图能出候选 |
| 14 | `ai-context` + `AiModule` + 自检 | 场景 A 第 9 步可用 |
| 15 | 往返：区块标记 + 三方合并 | 场景 D 可用 |
| 16 | `exporter`（svg/png/json）+ 画布导出按钮 | 导出图与画布一致 |
| 17 | `apps/cli`：文件模式 + `gen --check` + `lint --format json` | CI 漂移门禁可用 |
| 18 | CLI 完整（sarif / import / export / diff）+ `exporter`（mermaid/drawio） | 无 UI 完成全链路 |

> 顺序说明：第 16、17 项原本排在最后（打包/CLI），现因「CLI 是架构约束」前移——**文件模式必须在 IR 加载层就存在**，否则后期改存储布局要迁移。
