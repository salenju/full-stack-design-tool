/**
 * 代码生成器的公共契约。
 *
 * 为什么把 `CodeGenerator` 定义在 runtime 而不是每个生成器各写一份：
 * 编译管线（以及将来的 CLI `fsdt gen`、增量生成、漂移检测）只认这一个接口。
 * 生成器之间不能互相 import——NestJS 生成器不该知道 Vue 生成器的存在。
 */

import type { IR } from '@fsdt/core-ir';

/** 生成物的类别，决定覆盖策略与 UI 上的分组 */
export type FileKind =
  | 'page'
  | 'component'
  | 'type'
  | 'client'
  | 'router'
  | 'store'
  | 'module'
  | 'controller'
  | 'dto'
  | 'service'
  | 'schema'
  | 'config'
  | 'style'
  | 'doc';

/**
 * 覆盖策略。
 *
 * - `always`：完全由 IR 决定，用户改了就丢（如路由表、Prisma schema）。
 * - `if-generated`：带 `@dsg:generated` 标记的文件。默认全新内容覆盖，但如果检测到
 *   用户改过（文件哈希与 manifest 不一致），保留用户改动并报告冲突。
 * - `never`：只在文件不存在时写入（如 `.env.example`、手写业务代码所在文件）。
 */
export type OverwritePolicy = 'always' | 'if-generated' | 'never';

export interface FilePlan {
  /** 相对输出根的路径，POSIX 分隔符 */
  path: string;
  kind: FileKind;
  /** 来源 IR 节点 ID，用于增量生成与 manifest 追溯 */
  sourceNodeIds: string[];
  overwrite: OverwritePolicy;
  /** 人类可读的用途说明，写进 manifest 与生成报告 */
  description?: string;
}

export type Language = 'ts' | 'vue' | 'prisma' | 'json' | 'css' | 'md' | 'html' | 'env';

export interface RenderedFile {
  path: string;
  content: string;
  language: Language;
  kind: FileKind;
  sourceNodeIds: string[];
  overwrite: OverwritePolicy;
  /** 文件内可独立替换的区块 */
  regions: RegionInfo[];
}

export interface RegionInfo {
  name: string;
  mode: RegionMode;
  /** 区块内容的哈希（不含标记行），用于三方合并判断 */
  hash: string;
  startLine: number;
  endLine: number;
}

export type RegionMode = 'generated' | 'handwritten' | 'todo';

export interface CompileContext {
  /** 项目名，用于 package.json、README 等 */
  projectName: string;
  /** 输出根（相对路径），只用于拼说明文字，不做 IO */
  outputRoot: string;
  /** 覆盖既有请求，默认 false */
  force?: boolean;
}

export interface CodeGenerator {
  readonly id: string;
  readonly version: string;
  /** 决定要产出哪些文件。纯函数，不做 IO，不读环境。 */
  plan(ir: IR, ctx: CompileContext): FilePlan[];
  /** 渲染单个文件。纯函数：相同输入必须产生相同字节。 */
  render(plan: FilePlan, ir: IR, ctx: CompileContext): Promise<RenderedFile>;
}
