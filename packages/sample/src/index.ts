/**
 * @fsdt/sample 公共入口。
 *
 * 示例数据是编译管线的独立阶段（不塞进 compiler 包）的理由：
 * 它需要跑引用完整性解析与拓扑排序，比 OpenAPI 生成重一个量级，
 * 且生成代码时**不需要**它（只有预览和 seed.json 需要）。分开才能按需调用。
 */

export { createRng, hashSeed } from './rng.js';
export type { Rng } from './rng.js';

export { detectSemantic, isSensitive } from './semantic.js';
export type { SemanticKind } from './semantic.js';

export {
  generateSamples,
  sensitiveFieldWarnings,
  toSeedJson,
} from './generate.js';
export type {
  SampleOptions,
  SampleOutputOptions,
  SampleResult,
  SampleRow,
  TableSample,
} from './generate.js';

export { toHttpFile, toPostmanCollection, toSeedSql } from './exports.js';
export type { ExportSampleOptions, PostmanCollection, SeedSqlOptions } from './exports.js';
