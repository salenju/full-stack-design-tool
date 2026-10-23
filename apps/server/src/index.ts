/**
 * `@fsdt/server` —— 服务模式（TD 5.2 模式 A）。
 *
 * 两种模式的边界（必须遵守，否则会双写冲突）：
 * - 文件模式（CLI / CI / git 协作）：权威存储是仓库里的 `design/ir.json`，
 *   CLI 直接读写文件，**不碰** `~/.fsdt/index.sqlite`；
 * - 服务模式：权威存储是 `~/.fsdt/`，CLI 通过 HTTP 调 `/api/*`，不直接写盘。
 *
 * `fsdt link <dir>` 把仓库的 `design/` 登记为某个项目的权威存储，此后 UI 与 CLI
 * 编辑同一份文件，靠 `If-Match` 哈希避免互相覆盖。
 */

export { buildRouter, startServer, type RunningServer, type ServerOptions } from './http.js';
export { JobRegistry, jobView, type Job, type JobEvent, type JobEventType, type JobKind, type JobState } from './jobs.js';
export { Router, type HttpResponse, type RequestContext, type RouteHandler } from './router.js';
export {
  NotFoundError,
  ProjectStore,
  ValidationError,
  VersionConflictError,
  type CanvasDoc,
  type ProjectRecord,
  type SnapshotRecord,
} from './store.js';
export { createZip, type ZipEntry } from './zip.js';
export { SERVER_VERSION } from './handlers.js';
