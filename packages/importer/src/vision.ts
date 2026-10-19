/**
 * 图片通道：视觉模型输出 → 字段候选（TD 8.3）。
 *
 * **本模块不自己调模型**。原因不是「省事」，而是：
 * - 模型选择、密钥、重试、成本都由应用层决定，导入包不该绑死某一家；
 * - 测试要能跑在离线环境（CI 上没有 API Key），所以模型调用必须是注入的。
 * 这里做的是模型**之后**的全部工作：校验、归一化、打分、去重、坐标换算。
 *
 * 关于「模型会编字段」这件事的应对：
 * 1. 强制结构化输出，且 `type`/`control` 必须是闭集，越界即丢弃该候选；
 * 2. `confidence < 0.5` 的候选保留但排在最后，并在面板上标注「需核对」；
 * 3. bbox 用归一化坐标（0–1），越界即视为模型幻觉；
 * 4. 校验失败重试一次，仍失败则降级为「只有文本列表、无 bbox」——
 *    降级也要能用，不能整批失败。
 */

import type { FieldType } from '@fsdt/core-ir';
import { FLD_MAX } from './limits.js';
import { candidateIdOf, toFieldName, toRoute } from './naming.js';
import type {
  BBox,
  CandidateControl,
  CandidateExtractor,
  CandidateGroup,
  CandidatePage,
  Evidence,
  ExtractionResult,
  ExtractorContext,
  ExtractorInput,
  FieldCandidate,
  GroupRole,
} from './types.js';

/** 闭集：模型只能从这些值里选，越界即视为幻觉 */
export const VISION_TYPES: FieldType[] = [
  'string',
  'text',
  'number',
  'integer',
  'boolean',
  'date',
  'datetime',
  'enum',
  'object',
  'array',
  'ref',
  'file',
  'json',
];

export const VISION_CONTROLS: CandidateControl[] = [
  'input',
  'textarea',
  'number',
  'select',
  'radio',
  'checkbox',
  'switch',
  'date',
  'datetime',
  'upload',
  'cascader',
  'slot',
];

const ROLES: GroupRole[] = ['search', 'table', 'form', 'detail'];

/**
 * 结构化输出契约（写进 prompt，也用于校验）。
 *
 * prompt 里必须包含三条强约束（TD 8.3）：
 * - bbox 用归一化坐标；
 * - 不确定的字段给 confidence < 0.5；
 * - 禁止编造图片中不存在的字段。
 * 校验只看数据，prompt 的效果不可测，所以这里宁可严一点。
 */
export interface VisionRawCandidate {
  name?: unknown;
  label?: unknown;
  type?: unknown;
  control?: unknown;
  confidence?: unknown;
  bbox?: unknown;
  group?: unknown;
  reason?: unknown;
}

export interface VisionRawOutput {
  pages?: unknown;
  groups?: unknown;
  candidates?: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 归一化 bbox → 像素。越界（任一维不在 0–1）视为幻觉，返回 undefined */
export function denormalizeBbox(bbox: unknown, width: number, height: number): BBox | undefined {
  if (!isObject(bbox)) return undefined;
  const nums = [bbox.x, bbox.y, bbox.w ?? bbox.width, bbox.h ?? bbox.height];
  if (!nums.every((n) => typeof n === 'number' && Number.isFinite(n))) return undefined;
  const [x, y, w, h] = nums as [number, number, number, number];
  if (x < 0 || y < 0 || w <= 0 || h <= 0 || x > 1 || y > 1 || w > 1 || h > 1) return undefined;
  return { x: x * width, y: y * height, w: w * width, h: h * height };
}

export interface NormalizeOptions {
  /** 原图像素尺寸，用于把归一化 bbox 换算回像素 */
  imageWidth: number;
  imageHeight: number;
}

export interface NormalizedOutcome {
  candidates: FieldCandidate[];
  groups: CandidateGroup[];
  pages: CandidatePage[];
  warnings: string[];
  /** 被丢弃的候选数（越界类型/控件），用于在面板上提示「模型输出了 N 条无效项」 */
  dropped: number;
}

/**
 * 校验并归一化模型输出。
 *
 * 丢弃而不是「修正」：把 `type: 'datetime2'` 改成 `string` 看起来友好，
 * 但那等于把模型的错误洗白成我们的判断。丢弃至少是可解释的。
 */
export function normalizeVisionOutput(raw: unknown, options: NormalizeOptions): NormalizedOutcome {
  const warnings: string[] = [];
  const groups: CandidateGroup[] = [];
  const pages: CandidatePage[] = [];
  const candidates: FieldCandidate[] = [];
  let dropped = 0;

  if (!isObject(raw)) {
    return { candidates, groups, pages, warnings: ['模型输出不是 JSON 对象，无法解析'], dropped: 0 };
  }

  const output = raw as VisionRawOutput;

  if (Array.isArray(output.groups)) {
    for (const item of output.groups) {
      if (!isObject(item)) continue;
      const role = typeof item.role === 'string' ? item.role : undefined;
      if (role === undefined || !ROLES.includes(role as GroupRole)) {
        dropped++;
        continue;
      }
      const label = typeof item.label === 'string' ? item.label : '未命名区域';
      groups.push({
        id: candidateIdOf('group', `${label}:${role}`),
        label,
        role: role as GroupRole,
        ...(denormalizeBbox(item.bbox, options.imageWidth, options.imageHeight) !== undefined
          ? { bbox: denormalizeBbox(item.bbox, options.imageWidth, options.imageHeight)! }
          : {}),
      });
    }
  }

  if (Array.isArray(output.pages)) {
    for (const item of output.pages) {
      if (!isObject(item) || typeof item.name !== 'string') continue;
      const segments = item.name.split(/[/_\-\s]+/).filter((s) => s.length > 0);
      pages.push({
        name: item.name,
        suggestedRoute: toRoute(segments.length > 0 ? segments : ['page']),
        ...(denormalizeBbox(item.bbox, options.imageWidth, options.imageHeight) !== undefined
          ? { bbox: denormalizeBbox(item.bbox, options.imageWidth, options.imageHeight)! }
          : {}),
      });
    }
  }

  if (!Array.isArray(output.candidates)) {
    warnings.push('模型输出缺少 candidates 数组');
    return { candidates, groups, pages, warnings, dropped };
  }

  let index = 0;
  for (const item of output.candidates) {
    index++;
    if (!isObject(item)) {
      dropped++;
      continue;
    }
    const entry = item as VisionRawCandidate;
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    if (name.length === 0) {
      dropped++;
      continue;
    }
    const type = typeof entry.type === 'string' ? entry.type : undefined;
    const control = typeof entry.control === 'string' ? entry.control : undefined;
    if (type === undefined || !VISION_TYPES.includes(type as FieldType)) {
      dropped++;
      continue;
    }
    if (control === undefined || !VISION_CONTROLS.includes(control as CandidateControl)) {
      dropped++;
      continue;
    }
    const confidenceRaw = typeof entry.confidence === 'number' ? entry.confidence : 0.5;
    const confidence = Math.max(0, Math.min(1, confidenceRaw));
    const bbox = denormalizeBbox(entry.bbox, options.imageWidth, options.imageHeight);
    const evidence: Evidence[] = [{ kind: 'inferred', value: typeof entry.reason === 'string' ? entry.reason : '视觉模型识别' }];
    if (bbox !== undefined) evidence.push({ kind: 'bbox', value: `${bbox.x},${bbox.y} ${bbox.w}×${bbox.h}`, bbox });

    const groupLabel = typeof entry.group === 'string' ? entry.group : undefined;
    const group = groupLabel === undefined ? undefined : groups.find((g) => g.label === groupLabel);
    const normalizedName = toFieldName(name);

    candidates.push({
      id: candidateIdOf('vision', `${name}:${index}`),
      name,
      ...(normalizedName !== undefined ? { normalizedName } : {}),
      ...(typeof entry.label === 'string' ? { label: entry.label } : {}),
      type: type as FieldType,
      control: control as CandidateControl,
      confidence,
      evidence,
      ...(group !== undefined ? { group: { id: group.id, label: group.label, role: group.role } } : {}),
      decision: 'pending',
    });
  }

  // 低置信度排到最后：面板按顺序展示时，用户会先处理有把握的
  candidates.sort((a, b) => b.confidence - a.confidence || (a.id < b.id ? -1 : 1));

  if (candidates.length === 0) warnings.push('模型未识别出任何字段，请检查图片是否包含表单或表格');
  if (dropped > 0) warnings.push(`模型输出了 ${dropped} 条越界或残缺项（类型/控件不在闭集内），已丢弃`);
  if (candidates.length > FLD_MAX) {
    warnings.push(`候选数超过 ${FLD_MAX} 条，已截断`);
    candidates.length = FLD_MAX;
  }

  return { candidates, groups, pages, warnings, dropped };
}

/** 模型调用签名：输入 base64 图片与 prompt，返回解析后的 JSON */
export type VisionModelCaller = (input: { imageBase64: string; prompt: string; mimeType: string }) => Promise<unknown>;

export const VISION_PROMPT = `你是一个 UI 设计稿解析器。请只输出 JSON，不要任何解释文字。
输出结构：{"pages":[...],"groups":[...],"candidates":[...]}
- candidates 每项含：name（英文字段名，camelCase；若设计稿只有中文，用中文）、label（界面上的显示文字）、type（必须是 ${VISION_TYPES.join('|')} 之一）、control（必须是 ${VISION_CONTROLS.join('|')} 之一）、confidence（0–1）、bbox（归一化坐标 {x,y,w,h}，0–1）、group（所属区域 label）、reason（判断依据）
- groups 每项含：label、role（search|table|form|detail）、bbox
- bbox 一律使用相对整张图片的归一化坐标（0–1）
- 不确定的字段 confidence 必须 < 0.5
- 禁止编造图片中不存在的字段`;

export interface VisionExtractorOptions {
  /** 模型调用器，必填（本包不内置任何 provider） */
  callModel: VisionModelCaller;
  imageWidth: number;
  imageHeight: number;
  /** 校验失败后是否重试一次，默认 true */
  retryOnInvalid?: boolean;
}

export function createVisionExtractor(options: VisionExtractorOptions): CandidateExtractor {
  return {
    channel: 'vision',
    async extract(input: ExtractorInput, ctx: ExtractorContext = {}): Promise<ExtractionResult> {
      void ctx;
      if (input.imagePath === undefined || input.imagePath.length === 0) {
        throw new Error('图片导入需要 imagePath');
      }
      const mimeType = input.imagePath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
      const first = await options.callModel({ imageBase64: input.imagePath, prompt: VISION_PROMPT, mimeType });
      let outcome = normalizeVisionOutput(first, options);
      // 只有「整体结构坏掉」才重试。部分项越界不重试——那会白烧一次 token，
      // 而且第二次也可能同样坏
      if (outcome.candidates.length === 0 && (options.retryOnInvalid ?? true)) {
        const second = await options.callModel({ imageBase64: input.imagePath, prompt: VISION_PROMPT, mimeType });
        outcome = normalizeVisionOutput(second, options);
      }
      return {
        candidates: outcome.candidates,
        groups: outcome.groups,
        pages: outcome.pages,
        warnings: outcome.warnings,
        raw: first,
      };
    },
  };
}
