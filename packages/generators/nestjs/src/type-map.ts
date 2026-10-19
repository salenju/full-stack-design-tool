/**
 * IR 字段 → TypeScript 类型。
 *
 * 单独抽出来的理由：DTO（class）、响应接口（interface）、Swagger 内联 schema
 * 三处都要把同一个 IR 字段映射成 TS 类型。各算一遍必然出现
 * 「DTO 里是 string、响应里是 number」这种前后端都发现不了的漂移。
 */

import { toPascalCase, type Field, type GraphIndex, type IR } from '@fsdt/core-ir';
import { quote } from '@fsdt/generators-runtime';

export interface TypeCtx {
  ir: IR;
  g: GraphIndex;
}

/** 字段在 TS 里是否应该带 `?`：非必填或可空都算可选 */
export function isOptionalField(field: Field): boolean {
  return !field.required || field.nullable;
}

export function tsTypeOfField(ctx: TypeCtx, field: Field): string {
  const c = field.constraints;
  switch (field.type) {
    case 'string':
    case 'text':
    case 'file':
      return 'string';
    case 'number':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'date':
    case 'datetime':
      return 'string';
    case 'enum': {
      if (c?.enumRef !== undefined) {
        const def = ctx.g.enums.get(c.enumRef);
        if (def !== undefined) return toPascalCase(def.name);
      }
      if (c?.enumValues !== undefined && c.enumValues.length > 0) {
        return c.enumValues.map((v) => quote(v)).join(' | ');
      }
      return 'string';
    }
    case 'array': {
      const item = c?.arrayItem ?? 'string';
      // 数组元素类型递归求值，但要清掉 arrayItem，否则 string[] 会算成 string[][]... 无解
      return `${tsTypeOfField(ctx, { ...field, type: item, constraints: { ...c, arrayItem: undefined } })}[]`;
    }
    case 'object':
    case 'json':
      return 'Record<string, unknown>';
    case 'ref': {
      // 外键类型跟着目标主键走：目标用 string 主键就不能声明 number
      const ref = c?.ref;
      if (ref === undefined) return 'string';
      const target = ctx.ir.nodes.find((n) => n.id === ref.tableId);
      if (target === undefined || target.kind !== 'table') return 'string';
      const pk =
        ref.fieldId !== undefined
          ? target.table.fields.find((f) => f.id === ref.fieldId)
          : ctx.g.primaryKey.get(target.id);
      if (pk === undefined) return 'string';
      return pk.type === 'integer' || pk.type === 'number' ? 'number' : 'string';
    }
    default:
      return 'string';
  }
}
