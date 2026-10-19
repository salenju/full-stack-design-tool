/**
 * @fsdt/core-ir/testing —— 测试专用导出。
 *
 * 为什么把 fixture 构造器放进 src 而不是 test/：
 * 下游包（compiler / generators / cli）的测试都需要一份「完整的 IR」。
 * 如果 fixture 留在 core-ir/test/，下游只能靠 `../../core-ir/test/fixtures.js` 这种
 * 跨包相对路径引用——绕过了 package exports，路径一改全崩，而且 tsc 的 rootDir 也不允许。
 * 放进 src/testing 后它就是正式的包导出，下游写 `@fsdt/core-ir/testing` 即可。
 *
 * 注意：本文件不进主入口 index.ts，避免把测试数据带进生产包的引用图。
 */

export { buildFixture, cloneIR, withSettings, danglingNodeId } from './fixtures.js';
export type { FixtureResult } from './fixtures.js';
