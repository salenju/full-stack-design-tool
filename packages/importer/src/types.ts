/**
 * 导入子系统的统一抽象（TD 8.1）。
 *
 * 一条贯穿整个模块的纪律：**导入永远只是「产生候选」，绝不是「直接改 IR」**。
 * 原因：无论 Figma 节点树还是视觉模型，召回率都不可能到 100%，
 * 而自动写进 IR 的错误字段会被下游一路放大（OpenAPI 多一个字段 → DTO 多一个
 * 校验 → 前后端都按它写代码）。所以本模块的输出是 `FieldCandidate[]`，
 * 由用户在候选面板逐条确认后才走 `applyDecisions` 落盘。
 *
 * 第二个纪律：**每个候选必须能解释自己**。`evidence` 不是装饰——没有证据的候选
 * 用户无法判断该不该接受，面板就退化成「闭眼全选」，而全选等价于自动写入。
 */

import type { FieldBinding, FieldType } from '@fsdt/core-ir';

export type ImportChannel = 'figma' | 'vision';

export type CandidateControl = NonNullable<FieldBinding['control']>;

export type GroupRole = 'search' | 'table' | 'form' | 'detail';

export type EvidenceKind = 'text' | 'layerName' | 'component' | 'placeholder' | 'bbox' | 'inferred';

export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Evidence {
  kind: EvidenceKind;
  value: string;
  bbox?: BBox;
  /** Figma 节点路径，如 'DeviceList / Table / Cell / deviceName' */
  nodePath?: string;
}

export type CandidateDecision = 'pending' | 'accepted' | 'renamed' | 'retyped' | 'rejected';

export interface FieldCandidate {
  /** 'cd_' + 稳定哈希，同一输入两次提取得到同一 ID（便于对比两次导入） */
  id: string;
  /** 原始建议名，可能为中文 */
  name: string;
  /** camelCase 建议名 */
  normalizedName?: string;
  label?: string;
  type: FieldType;
  control: CandidateControl;
  /** 0..1 */
  confidence: number;
  evidence: Evidence[];
  group?: { id: string; label: string; role: GroupRole };
  decision: CandidateDecision;
}

export interface CandidateGroup {
  id: string;
  label: string;
  role: GroupRole;
  bbox?: BBox;
}

export interface CandidatePage {
  name: string;
  bbox?: BBox;
  suggestedRoute: string;
}

export interface ExtractionResult {
  candidates: FieldCandidate[];
  groups: CandidateGroup[];
  pages: CandidatePage[];
  warnings: string[];
  /** 原始输入，存 imports/<jobId>.json 便于复查 */
  raw?: unknown;
}

export interface ExtractorContext {
  /**
   * 缓存目录。Figma 节点树按 `fileKey + nodeId + fileVersion` 缓存，
   * 命中即复用——否则反复预览会把 token 打到限流。
   */
  cacheDir?: string;
  /** 网络访问，测试注入用 */
  fetchJson?: (url: string, headers: Record<string, string>) => Promise<unknown>;
}

export interface ExtractorInput {
  channel: ImportChannel;
  /** Figma：fileKey */
  fileKey?: string;
  /** Figma：要导入的节点 ID 列表 */
  nodeIds?: string[];
  /** Figma：token 从环境变量取，绝不进 IR */
  token?: string;
  /** vision：图片路径或 base64 */
  imagePath?: string;
}

export interface CandidateExtractor {
  readonly channel: ImportChannel;
  extract(input: ExtractorInput, ctx?: ExtractorContext): Promise<ExtractionResult>;
}
