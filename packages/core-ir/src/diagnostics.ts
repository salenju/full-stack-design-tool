/**
 * 诊断信息（Diagnostic）——校验层与 Lint 层的统一输出格式。
 *
 * 放这里而不是放在 lint 包：`core-ir` 的基础校验（引用完整性、ID 唯一性）也要产诊断，
 * 若把类型放 lint 包会造成 core-ir → lint 的反向依赖。
 */
export type Severity = 'info' | 'warn' | 'error';

export interface DiagnosticTarget {
  nodeId?: string;
  fieldId?: string;
  edgeId?: string;
  componentId?: string;
  canvasId?: string;
}

export interface Diagnostic {
  /** 基础校验用 'IR001' 这类；Lint 规则用 'L001' */
  code: string;
  severity: Severity;
  message: string;
  target: DiagnosticTarget;
  /** 可选的修复建议，UI 据此显示「一键修复」 */
  fix?:
    | { kind: 'setType'; payload: { fieldId: string; type: string } }
    | { kind: 'addField'; payload: unknown }
    | { kind: 'addBinding'; payload: unknown }
    | { kind: 'rename'; payload: { id: string; to: string } }
    | { kind: 'removeEdge'; payload: { edgeId: string } }
    | { kind: 'removeNode'; payload: { nodeId: string } };
}

export class IRValidationError extends Error {
  constructor(
    message: string,
    readonly diagnostics: Diagnostic[],
  ) {
    super(message);
    this.name = 'IRValidationError';
  }
}

export function isDiagnostic(value: unknown): value is Diagnostic {
  if (typeof value !== 'object' || value === null) return false;
  const d = value as Diagnostic;
  return typeof d.code === 'string' && typeof d.message === 'string' && typeof d.severity === 'string';
}
