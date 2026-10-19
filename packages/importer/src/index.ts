/**
 * @fsdt/importer — 设计图导入。
 *
 * 两个通道，同一套候选模型：
 * - Figma：结构化节点树，召回约 70%，**可复现**（同一 fileVersion 同结果）；
 * - 视觉模型：能处理任意截图，但模型调用不确定，靠「应用候选后的 IR 是确定的」兜底。
 *
 * 模块边界：本包**只产生候选与纯函数 IR 补丁**，不读文件、不发网络请求（Figma 请求
 * 走注入的 fetchJson，视觉模型走注入的 callModel），因此可以整体跑在浏览器、
 * 服务端或测试里。
 */

export {
  createFigmaExtractor,
  extractFromNodes,
  combineConfidence,
  groupRoleOf,
  FIGMA_API_BASE,
} from './figma.js';
export type { FigmaExtractorOptions, FigmaNode, FigmaNodesResponse } from './figma.js';

export {
  createVisionExtractor,
  normalizeVisionOutput,
  denormalizeBbox,
  VISION_PROMPT,
  VISION_TYPES,
  VISION_CONTROLS,
} from './vision.js';
export type {
  NormalizeOptions,
  NormalizedOutcome,
  VisionExtractorOptions,
  VisionModelCaller,
  VisionRawCandidate,
  VisionRawOutput,
} from './vision.js';

export { applyDecisions, bindToPage, sourceMarkOf, ApplyError } from './apply.js';
export type { ApplyResult, ApplyTarget, Decision, DecisionAction } from './apply.js';

export {
  candidateIdOf,
  toFieldName,
  toRoute,
  hasCJK,
  inferFromLayerName,
  inferFromText,
} from './naming.js';
export type { InferredType } from './naming.js';

export { FLD_MAX, DECISION_MAX } from './limits.js';

export type {
  BBox,
  CandidateControl,
  CandidateDecision,
  CandidateExtractor,
  CandidateGroup,
  CandidatePage,
  Evidence,
  EvidenceKind,
  ExtractionResult,
  ExtractorContext,
  ExtractorInput,
  FieldCandidate,
  GroupRole,
  ImportChannel,
} from './types.js';
