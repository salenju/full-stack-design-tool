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
fsdt lint                           # 跑契约规则
fsdt gen --out ./output             # 生成前后端（默认只预览）
fsdt gen --check                    # CI 门禁：产物与画布不一致则退出码 1
```

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

退出码：`0` 成功 / `1` 校验失败或存在差异 / `2` 用法错误。

## CLI 的三条纪律

1. **默认只读**：`gen`、`compile`、`export` 没有 `--out` 时只输出到 stdout，绝不写盘。
2. **进 CI 的命令必须确定性**：同 IR + 同 seed 两次生成字节级一致。
3. **`--check` 与 `--out` 互斥**：`--check` 是门禁，顺手把差异写掉会让 CI 永远绿。

## 包结构

```
apps/cli                      命令行
packages/core-ir              IR 类型 / Zod schema / 校验 / 语义哈希 / 迁移
packages/compiler             IR → OpenAPI 3.1 + UI Schema
packages/sample               确定性示例数据（内置 PRNG，不用 faker）
packages/lint                 L001–L014 规则 + SARIF
packages/exporter             SVG / PNG / Mermaid / draw.io / JSON / Figma
packages/importer             Figma / 视觉模型 → 字段候选
packages/generators/runtime   Writer / 区块标记 / manifest
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
pnpm build             # 全包 tsc -b
pnpm typecheck         # tsc -b + 逐包 typecheck
pnpm typecheck:tests   # 逐包检查测试文件类型
pnpm test              # 669 条单测
pnpm smoke             # 端到端：真跑一遍全部 CLI 命令
```

`pnpm smoke` 值得单独说：单测覆盖的是各包行为，而「CLI 装起来能不能跑通一条链路」
是另一回事——路径解析、退出码、`--check` 与 `--out` 互斥，只有真跑一次才看得见。
它在临时目录里 init → lint → compile → gen → 手改后验漂移 → 恢复 → 验幂等 → sample → export，
任何一步不符合预期就非零退出。

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
