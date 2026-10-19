/**
 * 候选名称的规范化与类型推断。
 *
 * **不转拼音**（TD 8.2 的明确决策）：`设备名称 → shebeimingcheng` 是反模式，
 * 生成的接口字段没人愿意维护。策略是：
 * - 有英文图层名 → 用它转 camelCase；
 * - 只有中文 → 保留中文作为 `label`，`name` 由用户在确认时补；
 * - 兜底 `field1` / `field2` 并给出 warning（比默默生成拼音诚实）。
 */

import type { FieldType } from '@fsdt/core-ir';
import type { CandidateControl } from './types.js';

const CONTROL_BY_LAYER: Array<{ pattern: RegExp; control: CandidateControl; type: FieldType }> = [
  { pattern: /^(input|textfield|text-field|text_input)$/i, control: 'input', type: 'string' },
  { pattern: /^(textarea|text-area|multiline)$/i, control: 'textarea', type: 'text' },
  { pattern: /^(select|dropdown|combobox)$/i, control: 'select', type: 'enum' },
  { pattern: /^(radio|radiogroup|radio-group)$/i, control: 'radio', type: 'enum' },
  { pattern: /^(checkbox|checkboxgroup)$/i, control: 'checkbox', type: 'array' },
  { pattern: /^(switch|toggle)$/i, control: 'switch', type: 'boolean' },
  { pattern: /^(datepicker|date-picker|date)$/i, control: 'date', type: 'date' },
  { pattern: /^(datetimepicker|date-time|datetime)$/i, control: 'datetime', type: 'datetime' },
  { pattern: /^(upload|filepicker|file-upload)$/i, control: 'upload', type: 'file' },
  { pattern: /^(numberinput|number|stepper)$/i, control: 'number', type: 'number' },
  { pattern: /^(cascader)$/i, control: 'cascader', type: 'array' },
];

/** 中文标签 → 类型推断。顺序优先：先命中先用，避免「创建时间」被当成「数量」 */
const TYPE_BY_LABEL: Array<{ pattern: RegExp; type: FieldType; control: CandidateControl }> = [
  { pattern: /(时间|日期|时刻)$/u, type: 'datetime', control: 'datetime' },
  { pattern: /(日期)$/u, type: 'date', control: 'date' },
  { pattern: /(金额|价格|费用|单价|总价)/u, type: 'number', control: 'number' },
  { pattern: /(数量|个数|条数|次数|库存|年龄|排序|序号)/u, type: 'integer', control: 'number' },
  { pattern: /(是否|启用|禁用|开关|在线)/u, type: 'boolean', control: 'switch' },
  { pattern: /(状态|类型|级别|等级|分类)/u, type: 'enum', control: 'select' },
  { pattern: /(图片|头像|照片|附件|文件|封面)/u, type: 'file', control: 'upload' },
  { pattern: /(备注|描述|说明|详情|内容)/u, type: 'text', control: 'textarea' },
];

/** 英文名 → 类型推断，与中文规则互补 */
const TYPE_BY_NAME: Array<{ pattern: RegExp; type: FieldType; control: CandidateControl }> = [
  { pattern: /(At|Time|Date)$/, type: 'datetime', control: 'datetime' },
  { pattern: /(Amount|Price|Fee|Cost|Total)$/i, type: 'number', control: 'number' },
  { pattern: /(Count|Num|Qty|Quantity|Age|Order)$/i, type: 'integer', control: 'number' },
  { pattern: /^(is|has|can|should)[A-Z]/, type: 'boolean', control: 'switch' },
  { pattern: /(Status|Type|Level|Kind|Category|State)$/i, type: 'enum', control: 'select' },
  { pattern: /(Image|Avatar|Photo|File|Attachment|Cover)(Url)?$/i, type: 'file', control: 'upload' },
  { pattern: /(Remark|Description|Comment|Note|Content)$/i, type: 'text', control: 'textarea' },
  { pattern: /(Password|Secret|Token)$/i, type: 'string', control: 'input' },
];

export interface InferredType {
  type: FieldType;
  control: CandidateControl;
  /** 推断依据，写进 evidence */
  reason?: string;
}

/** 从图层名（如 `Input/DeviceName`、`FormItem/status`）判断控件 */
export function inferFromLayerName(layerName: string): InferredType | undefined {
  const segments = layerName.split('/').map((s) => s.trim());
  for (const segment of segments) {
    for (const rule of CONTROL_BY_LAYER) {
      if (rule.pattern.test(segment)) return { type: rule.type, control: rule.control, reason: `图层名 ${segment}` };
    }
  }
  return undefined;
}

/** 从显示文本（标签 / placeholder）推断类型 */
export function inferFromText(text: string): InferredType | undefined {
  const trimmed = text.replace(/^(请输入|请选择|请填写|输入|选择)/u, '').trim();
  for (const rule of TYPE_BY_LABEL) {
    if (rule.pattern.test(trimmed)) return { type: rule.type, control: rule.control, reason: `文本「${text}」` };
  }
  for (const rule of TYPE_BY_NAME) {
    if (rule.pattern.test(trimmed)) return { type: rule.type, control: rule.control, reason: `文本「${text}」` };
  }
  // placeholder 前缀本身就能区分输入框与选择器
  if (/^请选择/u.test(text)) return { type: 'enum', control: 'select', reason: 'placeholder「请选择」' };
  if (/^请输入/u.test(text)) return { type: 'string', control: 'input', reason: 'placeholder「请输入」' };
  return undefined;
}

const CJK = /[\u3000-\u9fff\uff00-\uffef]/;

export function hasCJK(text: string): boolean {
  return CJK.test(text);
}

/** 中英文混合名 → camelCase。中文部分保留，只处理分隔符与首字母 */
export function toFieldName(raw: string): string | undefined {
  const cleaned = raw
    .replace(/^(Input|FormItem|TableColumn|Label|Field)[/_]/i, '')
    .replace(/[_\-/\s]+/g, ' ')
    .trim();
  if (cleaned.length === 0) return undefined;
  if (hasCJK(cleaned)) {
    // 纯中文不给自动化名：拼音是反模式，强行生成只会让用户手动改名
    if (!/[A-Za-z]/.test(cleaned)) return undefined;
  }
  const words = cleaned.split(' ').filter((w) => w.length > 0);
  if (words.length === 0) return undefined;
  const [first, ...rest] = words;
  const head = (first ?? '').charAt(0).toLowerCase() + (first ?? '').slice(1);
  const tail = rest.map((w) => w.charAt(0).toUpperCase() + w.slice(1));
  const out = [head, ...tail].join('');
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(out) ? out : undefined;
}

/** 路由建议：中文页面名不能直接当路由段 */
export function toRoute(segments: string[]): string {
  const parts = segments
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0)
    .map((s) => s.replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, ''))
    .filter((s) => s.length > 0);
  return `/${parts.join('/')}`;
}

/** 稳定候选 ID：同一份输入两次提取必须得到同一 ID，否则重复导入会产生重复字段 */
export function candidateIdOf(channel: string, key: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const hex = (h >>> 0).toString(16).padStart(8, '0');
  return `cd_${channel.slice(0, 2)}${hex}`;
}
