/**
 * ID 生成与解析。
 *
 * 约定：ID 带类型前缀，便于在日志、diff、Lint 报告中一眼看出它是什么；
 * 长度固定 12（nanoid），与类型设计文档 3.2 / 3.3 / 3.4 一致。
 */

import { customAlphabet } from 'nanoid';

/** nanoid 的 url-safe 字母表（去掉易混淆字符会导致基数不是 64，这里保持默认） */
const ALPHABET = 'useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict';

const nano = customAlphabet(ALPHABET, 12);

export const ID_PREFIX = {
  node: 'nd_',
  field: 'fd_',
  edge: 'ed_',
  component: 'cp_',
  canvas: 'cv_',
  asset: 'as_',
  enum: 'en_',
  model: 'md_',
  index: 'ix_',
  job: 'jb_',
  generation: 'gn_',
} as const;

export type IdKind = keyof typeof ID_PREFIX;

export function newId(kind: IdKind): string {
  return ID_PREFIX[kind] + nano();
}

export const newNodeId = (): string => newId('node');
export const newFieldId = (): string => newId('field');
export const newEdgeId = (): string => newId('edge');
export const newComponentId = (): string => newId('component');
export const newCanvasId = (): string => newId('canvas');
export const newAssetId = (): string => newId('asset');
export const newEnumId = (): string => newId('enum');
export const newModelId = (): string => newId('model');
export const newIndexId = (): string => newId('index');

/** 判断某 ID 是否属于给定类型（前缀匹配） */
export function isIdKind(id: string, kind: IdKind): boolean {
  return id.startsWith(ID_PREFIX[kind]);
}

/**
 * 校验 ID 形状：前缀正确 + 主体长度 12。
 * 用于 Zod schema，避免手工编辑 IR 时混入 `device1` 之类的裸名字。
 */
export function isValidId(id: string, kind: IdKind): boolean {
  const prefix = ID_PREFIX[kind];
  return id.startsWith(prefix) && id.length === prefix.length + 12;
}
