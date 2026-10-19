/**
 * 字段语义识别：从字段名 / 注释推断「这个字段应该造什么数据」。
 *
 * 为什么需要：纯按类型造数会造出 `deviceName: "字符串1"`、`phone: "abc"` 这种无用数据。
 * 用户在画布上看示例数据是为了**验证设计是否合理**，一眼看出「手机号是 13800138000」
 * 比「字符串」有用得多。
 *
 * 但识别必须**保守**：认不出来就退回类型默认值，绝不硬猜。猜错比不猜更糟——
 * 用户会以为工具理解了他的业务。
 *
 * 识别顺序：显式断言（field.example）> 注释关键词 > 字段名关键词 > 类型默认。
 */

import type { Field } from '@fsdt/core-ir';

export type SemanticKind =
  | 'id'
  | 'name'
  | 'personName'
  | 'email'
  | 'phone'
  | 'url'
  | 'ip'
  | 'uuid'
  | 'color'
  | 'address'
  | 'company'
  | 'title'
  | 'description'
  | 'code'
  | 'amount'
  | 'count'
  | 'percent'
  | 'age'
  | 'timestamp'
  | 'dateOnly'
  | 'booleanFlag'
  | 'fileName'
  | 'imageUrl'
  | 'enum'
  | 'json'
  | 'unknown';

interface Rule {
  kind: SemanticKind;
  /** 命中任一正则即认为匹配 */
  patterns: RegExp[];
  /** 只在这些字段类型上生效；undefined 表示不限 */
  types?: Field['type'][];
}

/**
 * 规则表。**顺序有意义**：靠前的优先。
 * 例如 `createdAt` 会同时命中 `at` 与 `time`，靠 timestamp 规则在前保证结果稳定。
 */
const RULES: Rule[] = [
  { kind: 'email', patterns: [/e[-_]?mail/i, /邮箱/, /邮件/] },
  { kind: 'phone', patterns: [/phone/i, /mobile/i, /tel(?![a-z])/i, /手机/, /电话/] },
  { kind: 'imageUrl', patterns: [/(avatar|image|photo|pic|thumbnail|cover)(url|uri|src)?$/i, /头像/, /图片/] },
  { kind: 'url', patterns: [/(url|uri|link|href|website|homepage)$/i, /链接/, /网址/] },
  { kind: 'ip', patterns: [/^ip(v4|v6)?$/i, /ipaddr/i, /ip地址/] },
  { kind: 'uuid', patterns: [/uuid/i, /guid/i] },
  { kind: 'color', patterns: [/colou?r$/i, /颜色/] },
  { kind: 'address', patterns: [/(address|addr)$/i, /地址/] },
  { kind: 'company', patterns: [/(company|organi[sz]ation|corporation|corp|brand)/i, /公司/, /组织/, /品牌/] },
  { kind: 'personName', patterns: [/(username|nickname|realname|fullname|author|owner|creator|operator|contact)$/i, /姓名/, /用户名/, /昵称/, /联系人/] },
  { kind: 'timestamp', patterns: [/(at|time|timestamp|datetime|created|updated|deleted|expired)$/i, /时间/], types: ['date', 'datetime', 'string', 'integer', 'number'] },
  { kind: 'dateOnly', patterns: [/(birthday|birthdate|date|day)$/i, /日期/, /生日/], types: ['date', 'string'] },
  { kind: 'amount', patterns: [/(amount|price|cost|fee|money|salary|balance|total|revenue|income)$/i, /金额/, /价格/, /费用/, /薪资/, /余额/], types: ['number', 'integer', 'string'] },
  { kind: 'percent', patterns: [/(percent|ratio|rate|progress)$/i, /百分比/, /比例/, /进度/], types: ['number', 'integer'] },
  { kind: 'count', patterns: [/(count|num|quantity|qty|size|stock|total)$/i, /数量/, /库存/], types: ['number', 'integer'] },
  { kind: 'age', patterns: [/^age$/i, /年龄/], types: ['number', 'integer'] },
  { kind: 'fileName', patterns: [/(file|filename|attachment|path)$/i, /文件/, /附件/], types: ['string', 'file'] },
  { kind: 'title', patterns: [/(title|subject|heading)$/i, /标题/] },
  { kind: 'description', patterns: [/(desc|description|remark|memo|comment|note|content|summary)$/i, /描述/, /备注/, /说明/, /内容/], types: ['string', 'text'] },
  { kind: 'code', patterns: [/(code|no|number|serial|sn|sku|key)$/i, /编号/, /编码/, /单号/] },
  { kind: 'name', patterns: [/(name|label|alias)$/i, /名称/, /名字/] },
  { kind: 'id', patterns: [/^id$/i, /_id$/i, /Id$/, /标识/] },
];

/** 命中规则则返回语义，否则 unknown */
export function detectSemantic(field: Field): SemanticKind {
  // 枚举/JSON/ref 不需要语义识别：它们有结构性生成方式
  if (field.type === 'enum') return 'enum';
  if (field.type === 'json' || field.type === 'object') return 'json';

  const haystacks: string[] = [field.name];
  if (field.comment !== undefined) haystacks.push(field.comment);
  if (field.description !== undefined) haystacks.push(field.description);

  for (const rule of RULES) {
    if (rule.types !== undefined && !rule.types.includes(field.type)) continue;
    for (const pattern of rule.patterns) {
      for (const text of haystacks) {
        if (pattern.test(text)) return rule.kind;
      }
    }
  }
  return 'unknown';
}

/** 敏感字段：只造看起来真实但不可用于生产的数据，并在 meta 里标明 */
export function isSensitive(field: Field): boolean {
  if (field.sensitive === true) return true;
  return /(password|passwd|secret|token|private[_-]?key|credential)/i.test(field.name);
}
