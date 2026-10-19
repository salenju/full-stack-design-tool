/**
 * @fsdt/generators-runtime
 *
 * 所有代码生成器共用的运行时：文件规划类型、文本 writer、区块标记、manifest。
 * 单独成包而不是塞进 @fsdt/compiler 的原因：
 * - 生成器要能被第三方实现（用户自己写 React 生成器），依赖越少越好；
 * - compiler 是「IR → 中间产物」，runtime 是「中间产物 → 文件」，两者升级节奏不同。
 */

export { Writer, toConstantCase, quote, commentSafe, objectLiteral, arrayLiteral } from './writer.js';
export type { WriterOptions } from './writer.js';

export {
  DO_NOT_EDIT_NOTICE,
  fileHeader,
  parseRegions,
  regionEnd,
  regionMarkers,
  regionStart,
  wrapRegion,
} from './markers.js';
export type { FileHeaderOptions, ParsedRegion, RegionOptions } from './markers.js';

export { diffManifest, needsFullRegeneration } from './manifest.js';
export type { Manifest, ManifestDiff, ManifestFile, ManifestRegion } from './manifest.js';

export type {
  CodeGenerator,
  CompileContext,
  FileKind,
  FilePlan,
  Language,
  OverwritePolicy,
  RegionInfo,
  RegionMode,
  RenderedFile,
} from './types.js';
