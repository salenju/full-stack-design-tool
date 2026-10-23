# 全栈全链路设计工具（fsdt）

从一个画布 IR 出发，编译出 **OpenAPI 契约 / UI Schema / 示例数据 / Vue 3 前端 / NestJS 后端**，
并能在 CI 里拦下「改了画布忘了重新生成」的漂移。

```
画布 IR（唯一真相源）
  ├─ compile → OpenAPI 3.1 / UI Schema / 示例数据 / Lint 报告
  ├─ gen     → Vue 3 + Element Plus 前端 / NestJS 12 + Prisma 后端
  ├─ export  → SVG / PNG / Mermaid / draw.io / JSON / Figma 脚本
  └─ lint    → L001–L014 契约规则（text / json / sarif）
```

## 为什么 IR 是唯一真相源

OpenAPI 没有页面布局词汇：它描述得了「`GET /devices` 返回什么」，描述不了
「设备列表页有个搜索框、表格、分页，点行跳详情页」。所以 OpenAPI 只能是**产物**，
不能是源头。真正的源头是画布 IR，其余一切都满足 `产物 = f(IR, Options)` 的纯函数关系
——这才让「同一 IR 两次生成字节一致」和「CI 漂移门禁」成立。

## 快速开始

```bash
pnpm install
pnpm build

cd /path/to/your-project
fsdt init --name 设备管理平台        # 创建 design/ir.json（文件模式）
fsdt compile --stdout json          # 看当前 IR 编译出的契约（不写盘）
fsdt lint                           # 跑契约规则（含 IR 语义诊断）
fsdt lint --fix                     # 自动修复能修的，写回 IR
fsdt gen --out ./output             # 生成前后端（默认只预览）
fsdt gen --check                    # CI 门禁：产物与画布不一致则退出码 1
```

`fsdt gen` 在渲染前会跑一遍语义校验与 Lint，有 error 级问题就中止——否则「非法 IR 生成出 31 个文件」这种事故只能等编译期才发现。确认要强行生成时加 `--skip-verify`。

## 画布工作台（apps/web）

CLI 之外的可视化入口：拖节点建图、改字段、跑 Lint、编译契约、生成产物、导出画布。

![工作台首页](docs/images/workbench-overview.png)

```bash
pnpm install
pnpm build      # 首次需要：工作台直接消费各包的 dist
pnpm dev        # → http://localhost:5180
```

**和 CLI 共用同一份 IR**：

| 情况 | 工作台用哪个文件 |
|---|---|
| 仓库根有 `design/ir.json` | 直接用它（和 `fsdt init` 生成的位置一致） |
| 没有 | 用 `.fsdt/web/design/ir.json`，首次打开种一份「设备管理」示例 |
| 想指向别处 | `FSDT_WEB_WORKSPACE=/path/to/project pnpm dev` |

界面上每处改动 800ms 防抖自动落盘，所以改完直接 `fsdt lint` / `fsdt gen` 就能看到结果，不需要导出导入。

数据通道是 vite 的 dev 中间件（`apps/web/server/`），不是一个独立后端进程——少一个进程就少一份「谁先写的」竞态，而且各端点直接调 `@fsdt/*` 的库函数，产物与命令行逐字节一致。

| 端点 | 作用 |
|---|---|
| `GET /api/state` | 读 IR + 工作区路径 + 语义哈希 |
| `PUT /api/ir` | 校验后原子写盘（校验不过拒绝写入） |
| `POST /api/lint` | L001–L014 |
| `POST /api/compile` | OpenAPI 3.1 + UI Schema |
| `POST /api/gen` | 渲染 Vue / NestJS，`write: true` 才落盘 |
| `POST /api/export` | svg / png / mermaid / drawio / json |

界面能力：四类节点（表 / 接口 / 页面 / 备注）、五类边（call / read / write / map / navigate，按两端类型自动判定）、字段级端口、表字段编辑器（含约束 / 枚举 / 外键）、接口与页面检查器、撤销重做（60 步）、自动保存、「整理布局」、Lint 面板点条目定位节点、一键修复、生成产物预览。

**还没做的**（对应技术设计里未落地的部分）：候选确认面板（Figma / 图片导入）、快照与回滚、服务模式（多项目 / HTTP API）、AI 填充。

## 命令

| 命令 | 作用 | 是否写盘 |
|---|---|---|
| `init` | 创建 `design/ir.json` | 是（不覆盖已有文件） |
| `compile` | IR → OpenAPI / UI Schema / 示例数据 | 仅 `--out` |
| `lint` | 契约规则检查 | 否 |
| `gen` | IR → 前后端代码 | 仅 `--out` |
| `sample` | 示例数据（确定性） | 仅 `--out` |
| `export` | 画布导出为图 | 仅 `--out` |
| `diff` | IR 语义 diff（坐标变化不算变化） | 否 |
| `import` | 设计图 → 字段候选（需人工确认） | 仅 `apply` |
| `serve` | 启动服务模式（多项目 / 快照 / 生成历史） | — |
| `link` | 把仓库的 `design/` 登记成服务模式里的项目 | 是（写索引） |

退出码：`0` 成功 / `1` 校验失败或存在差异 / `2` 用法错误。

## CLI 的三条纪律

1. **默认只读**：`gen`、`compile`、`export` 没有 `--out` 时只输出到 stdout，绝不写盘。
2. **进 CI 的命令必须确定性**：同 IR + 同 seed 两次生成字节级一致。
3. **`--check` 与 `--out` 互斥**：`--check` 是门禁，顺手把差异写掉会让 CI 永远绿。

## 包结构

```
apps/cli                      命令行
apps/server                   服务模式（HTTP API / 快照 / 生成任务）
apps/web                      画布工作台（Vue 3 + Vue Flow + Element Plus）
packages/core-ir              IR 类型 / Zod schema / 校验 / 语义哈希 / 迁移
packages/compiler             IR → OpenAPI 3.1 + UI Schema
packages/sample               确定性示例数据（内置 PRNG，不用 faker）
packages/lint                 L001–L014 规则 + SARIF
packages/exporter             SVG / PNG / Mermaid / draw.io / JSON / Figma
packages/importer             Figma / 视觉模型 → 字段候选
packages/generators/runtime   Writer / 区块标记 / 三方合并 / manifest
packages/generators/vue       Vue 3 + Element Plus
packages/generators/nestjs    NestJS 12 + Prisma
```

依赖方向严格单向：`core-ir ← 其余所有包`，生成器之间互不 import。

## 关键设计取舍

- **手写 interface + 手写 Zod schema**，不由 zod 反推类型：schema 要比接口更宽容（旧 IR 走默认值），
  反推会把类型全变可选，污染所有下游。漂移由 `schema-type-parity.test.ts` 的「静默丢键」检测兜住。
- **不用模板引擎**（Eta/Handlebars），用 `Writer` 手写：模板引擎的空白处理跨版本会变，
  一变所有黄金样例全红且原因不可见；Vue/NestJS 产物的三层嵌套缩进也要能算。
- **不用 faker 造数**：它的输出跨版本会变，升级后黄金样例全挂。内置 mulberry32 + 中文词表。
- **图片通道不内置模型 provider**：`createVisionExtractor` 通过注入 `callModel` 解耦，
  CLI 用 OpenAI 兼容协议适配（`FSDT_VISION_API_KEY` / `FSDT_VISION_BASE_URL` / `FSDT_VISION_MODEL`）。
- **字段改名不转拼音**：中文名保留为 `label`，`name` 由用户确认时补；兜底 `field1` 并告警。
- **导入只产生候选**，不直接写 IR：自动写入的错误字段会被 OpenAPI → DTO → 前后端一路放大。

## 开发

```bash
pnpm verify            # 一条命令跑完下面全部
pnpm build             # 全包 tsc -b（含 apps/web 的 vue-tsc + vite build）
pnpm typecheck         # tsc -b + 逐包 typecheck
pnpm typecheck:tests   # 逐包检查测试文件类型
pnpm test              # 752 条单测
pnpm smoke             # 端到端：真跑一遍全部 CLI 命令
pnpm dev               # 画布工作台（http://localhost:5180）
```

`pnpm smoke` 值得单独说：单测覆盖的是各包行为，而「CLI 装起来能不能跑通一条链路」
是另一回事——路径解析、退出码、`--check` 与 `--out` 互斥，只有真跑一次才看得见。
它在临时目录里 init → lint → compile → gen → 手改后验漂移 → 恢复 → 验幂等 →
往 todo 区块里写实现后重新生成 → sample → export，任何一步不符合预期就非零退出。

`pnpm verify` 的每一步在 CI（`.github/workflows/ci.yml`）里都有对应：本地跑什么、
CI 就跑什么，避免「本地绿、CI 红」之后大家开始改 CI 而不是改代码。

## 服务模式（多项目 / 快照 / 生成历史）

文件模式（`design/ir.json` + git）是默认形态，适合 CLI、CI 和多人评审。
但它没有「多项目」「快照回滚」「生成历史」这些东西——所以另有一套服务模式：

```bash
fsdt serve                      # 默认 http://127.0.0.1:4590，数据在 ~/.fsdt
fsdt link . --name 设备管理平台   # 把当前仓库的 design/ 登记成一个项目
```

| 场景 | 权威存储 | 写入方式 |
|---|---|---|
| `fsdt gen --ir design/ir.json`（文件模式） | 仓库内文件 | CLI 直接读写，**不碰** `~/.fsdt/` |
| `fsdt serve`（服务模式） | `~/.fsdt/` | 客户端走 HTTP `/api/*`，服务直接写盘 |
| `fsdt link` 之后 | 仓库里的 `design/` | UI 与 CLI 编辑同一份文件，靠 `If-Match` 哈希互不覆盖 |

存储布局：

```
~/.fsdt/
├── index.sqlite                 # 项目索引 + 快照元数据（Node 自带 node:sqlite，无原生依赖）
└── projects/<id>/
    ├── project.json             # 项目元数据 + settings + 字典
    ├── canvases/<canvasId>.ir.json   # 按画布拆分：保存时只写变动画布
    ├── snapshots/<id>.json      # 全量 IR 快照，可回滚
    ├── output/                  # 最近一次生成产物
    └── generations/<gid>/       # 历史生成（manifest + 产物快照）
```

主要端点（完整表见 `apps/server/src/http.ts`）：

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET`/`POST` | `/api/projects` | 项目列表 / 新建 |
| `GET` | `/api/projects/:id/ir` | 读 IR（`?canvas=all\|<id>`） |
| `PUT` | `/api/projects/:id/canvases/:canvasId` | 写画布，**必须**带 `If-Match` |
| `GET`/`POST` | `/api/projects/:id/snapshots` | 快照列表 / 建快照 |
| `POST` | `/api/projects/:id/snapshots/:sid/restore` | 回滚 |
| `POST` | `/api/projects/:id/lint` `/compile` | Lint 与编译预览 |
| `POST` | `/api/projects/:id/generate/preview` | 生成预览（只算不写） |
| `POST` | `/api/projects/:id/generate` | 执行生成，返回 `jobId`，进度走 SSE |
| `GET` | `/api/jobs/:jobId/events` | SSE：`job.created` / `job.progress` / `job.log` / `job.done` / `job.error` |
| `GET` | `/api/projects/:id/download` | 打包下载（zip，`?gen=<gid>` 取历史某版） |

两个刻意的选择：

- **写画布必须带 `If-Match`**（IR 的语义哈希），缺失返回 428、不匹配返回 409 并附上服务端最新哈希。静默覆盖别人的编辑是这类工具最不可接受的故障。
- **默认只监听 127.0.0.1**。这个服务能改项目文件、能生成代码，等价于本机写权限；要对外暴露请自己确认网络边界。

## 改过的代码还能重新生成（往返）

「重新生成会覆盖我写的代码」是这类工具最常见的死法：第一次手工修改之后就再也不敢跑 `gen`。
这里的解法是**区块标记 + 区块级三方合并**：

```ts
async listDevices(query: ListDevicesQueryDto): Promise<PageDevice> {
  // @dsg:todo start name=listDevices hash=8f3c1a…
  // 实现 listDevices：分页查询 Device，使用 query.page/query.pageSize 与筛选条件
  throw new NotImplementedException('listDevices');
  // @dsg:todo end name=listDevices
}
```

把中间那段换成你自己的实现，契约再怎么改都只更新区块外的骨架，方法体原样保留。

| 区块 | 重新生成时 |
|---|---|
| `@dsg:todo` / `@dsg:handwritten` | 一律保留磁盘内容（todo 就是你填的地方） |
| `@dsg:generated` | 没动过 → 换成新内容；动过 → 报冲突，保留你的内容 |
| 磁盘上多出来的区块 | 报冲突，不猜该挪到哪 |
| 磁盘上完全没有标记 | 报冲突，不合并（整个文件可能被重写过） |

生成器已经把最需要手写的三处包成了 `todo` 区块：NestJS service 的每个方法体、
后端 `main.ts` 的鉴权挂载点、Vue 页面 `<script setup>` 末尾的自定义区块。
区块外的一切（imports、签名、模板）由 IR 说了算，手写请放进区块里——文件头那句
`@dsg:generated` 提示说的就是这件事。

`fsdt gen` 的三种结局都会说清原因：

```
[backend] 新增/更新 0，未变 26，合并 2，冲突 0
合计：写入 0 个文件，2 个文件在原位合并（手写区块保留）
```

`fsdt gen --check` 用的是同一套合并规则：**往 todo 区块里写代码不算漂移**，
CI 不会因为「你实现了业务逻辑」而红灯；只有区块外与生成结果对不上才报漂移。

## 生成物是能真编译的

`packages/generators/nestjs/test/compile.test.ts` 会真的用 tsc 编译生成的后端工程；
前端侧则由 `vue-generator.test.ts` 里的「可编译性」用例守住几个坑：

- 接口字段不能写成 `unknown`（否则 `v-model` 全报 TS2322）
- 枚举必须带出类型定义（否则下拉框失去类型约束）
- store 的 `query` 要用类型别名，不能用 `Record<string, unknown>`
- 必须有 `src/env.d.ts`（否则 `import.meta.env` 报 TS2339）
- `package.json` 的 `name` 必须是合法 npm 包名（中文项目名会让 `pnpm install` 失败）
- Prisma 7 的 `url` 在 `prisma.config.ts`，不在 `schema.prisma`

## 文档

- [`docs/.../PRD-全栈全链路设计工具-1019.md`](docs/全栈全链路设置工具-1019/PRD-全栈全链路设计工具-1019.md)
- [`docs/.../TECH-DESIGN-全栈全链路设计工具-1019.md`](docs/全栈全链路设置工具-1019/TECH-DESIGN-全栈全链路设计工具-1019.md)
- [`docs/.../BRD-全栈全链路设置工具-1019.md`](docs/全栈全链路设置工具-1019/BRD-全栈全链路设置工具-1019.md)
