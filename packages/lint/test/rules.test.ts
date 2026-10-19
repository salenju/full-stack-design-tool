import {
  createAction,
  createApiNode,
  createEmptyIR,
  createField,
  createForm,
  createPageNode,
  createSearchForm,
  createTable,
  createTableNode,
  newEdgeId,
  type IR,
} from '@fsdt/core-ir';
import { buildFixture } from '@fsdt/core-ir/testing';
import { describe, expect, it } from 'vitest';

import { groupByTarget, runLint, toSarif, LINT_RULES } from '../src/rules.js';

/** 在 fixture 的 IR 上做局部改动，返回新 IR（fixture 每次调用都是新对象） */
function withFixture(mutate: (ir: IR) => void): IR {
  const { ir } = buildFixture();
  mutate(ir);
  return ir;
}

function issuesOf(ir: IR, ruleId?: string) {
  const result = runLint(ir);
  return ruleId === undefined ? result.issues : result.issues.filter((i) => i.ruleId === ruleId);
}

describe('规则注册', () => {
  it('L001–L014 全部注册且 id 唯一', () => {
    const ids = LINT_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([
      'L001', 'L002', 'L003', 'L004', 'L005', 'L006', 'L007',
      'L008', 'L009', 'L010', 'L011', 'L012', 'L013', 'L014',
    ]);
  });

  it('每条规则都有标题与说明', () => {
    for (const rule of LINT_RULES) {
      expect(rule.title.length).toBeGreaterThan(0);
      expect(rule.description.length).toBeGreaterThan(0);
    }
  });

  it('fixture 本身是干净的（无 error）', () => {
    const { ir } = buildFixture();
    const result = runLint(ir);
    expect(result.issues.filter((i) => i.severity === 'error')).toEqual([]);
  });
});

// ────────────────────────────── 逐条规则 ──────────────────────────────

describe('L001 动作未绑定', () => {
  it('既无接口也无跳转时报 warn', () => {
    const ir = withFixture((mut) => {
      const page = mut.nodes.find((n) => n.kind === 'page')!;
      if (page.kind !== 'page') throw new Error('unreachable');
      page.page.components.push(createAction({ title: '空按钮' }));
    });
    const issues = issuesOf(ir, 'L001');
    expect(issues.length).toBe(1);
    expect(issues[0]!.severity).toBe('warn');
    expect(issues[0]!.target.componentId).toBeDefined();
  });

  it('绑了接口不报', () => {
    const ir = withFixture((mut) => {
      const page = mut.nodes.find((n) => n.kind === 'page')!;
      const api = mut.nodes.find((n) => n.kind === 'api')!;
      if (page.kind !== 'page') throw new Error('unreachable');
      page.page.components.push(createAction({ title: '提交', apiRef: api.id }));
    });
    expect(issuesOf(ir, 'L001')).toEqual([]);
  });

  it('配了跳转不报', () => {
    const ir = withFixture((mut) => {
      const page = mut.nodes.find((n) => n.kind === 'page')!;
      if (page.kind !== 'page') throw new Error('unreachable');
      page.page.components.push(createAction({ title: '去详情', navigateTo: '/devices/1' }));
    });
    expect(issuesOf(ir, 'L001')).toEqual([]);
  });
});

describe('L002 悬空连线', () => {
  it('指向不存在节点时报 error 并给删除修复', () => {
    const ir = withFixture((mut) => {
      const page = mut.nodes.find((n) => n.kind === 'page')!;
      mut.edges.push({
        id: newEdgeId(),
        kind: 'call',
        source: { nodeId: page.id },
        target: { nodeId: 'nd_DOESNOTEXIST' },
        trigger: { event: 'click' },
        canvasId: mut.canvases[0]!.id,
      });
    });
    const issues = issuesOf(ir, 'L002');
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0]!.severity).toBe('error');
    expect(issues[0]!.fix?.kind).toBe('removeEdge');
  });

  it('正常连线不报', () => {
    const { ir } = buildFixture();
    expect(issuesOf(ir, 'L002')).toEqual([]);
  });
});

describe('L003 映射类型不兼容', () => {
  it('string → integer 且无转换函数报 error', () => {
    const ir = withFixture((mut) => {
      const api = mut.nodes.find((n) => n.kind === 'api')!;
      const page = mut.nodes.find((n) => n.kind === 'page')!;
      if (api.kind !== 'api' || page.kind !== 'page') throw new Error('unreachable');
      // 造一个字符串响应字段与一个整数字段
      const strField = createField({ name: 'rawValue', type: 'string' });
      api.api.responses[0]!.fields.push(strField);
      const intField = createField({ name: 'count', type: 'integer' });
      page.page.components.push(
        createForm(api.id, [{ fieldRef: intField.id }]),
      );
      mut.nodes.push(
        createTableNode({
          name: 'Holder',
          codeName: 'Holder',
          canvasId: page.canvasId,
          table: { dbName: 'holders', fields: [intField], indexes: [], softDelete: false, timestamps: false },
        }),
      );
      mut.edges.push({
        id: newEdgeId(),
        kind: 'map',
        source: { nodeId: api.id, fieldId: strField.id },
        target: { nodeId: page.id, fieldId: intField.id },
        canvasId: mut.canvases[0]!.id,
      });
    });
    const issues = issuesOf(ir, 'L003');
    expect(issues.length).toBe(1);
    expect(issues[0]!.message).toContain('rawValue');
  });

  it('配了 trim 等转换函数就不报', () => {
    const ir = withFixture((mut) => {
      const api = mut.nodes.find((n) => n.kind === 'api')!;
      const page = mut.nodes.find((n) => n.kind === 'page')!;
      if (api.kind !== 'api' || page.kind !== 'page') throw new Error('unreachable');
      const strField = createField({ name: 'rawValue', type: 'string' });
      api.api.responses[0]!.fields.push(strField);
      const intField = createField({ name: 'count', type: 'integer' });
      mut.edges.push({
        id: newEdgeId(),
        kind: 'map',
        source: { nodeId: api.id, fieldId: strField.id },
        target: { nodeId: page.id, fieldId: intField.id },
        transform: { fn: 'toNumber' },
        canvasId: mut.canvases[0]!.id,
      });
    });
    expect(issuesOf(ir, 'L003').filter((i) => i.target.edgeId !== undefined)).toEqual([]);
  });
});

describe('L004 示例值（默认关闭）', () => {
  it('默认不产 issue', () => {
    const { ir } = buildFixture();
    expect(issuesOf(ir, 'L004')).toEqual([]);
  });

  it('显式开启后对缺 example 的响应字段报警', () => {
    const { ir } = buildFixture();
    const issues = runLint(ir, { overrides: { L004: 'info' } }).issues.filter((i) => i.ruleId === 'L004');
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]!.severity).toBe('info');
  });
});

describe('L005 必填字段缺控件', () => {
  it('表单漏掉必填字段报 warn 并给绑定修复', () => {
    const ir = withFixture((mut) => {
      const api = mut.nodes.find((n) => n.kind === 'api')!;
      if (api.kind !== 'api') throw new Error('unreachable');
      api.api.requestBody = {
        shape: 'object',
        required: true,
        contentType: 'application/json',
        fields: [createField({ name: 'deviceName', type: 'string', required: true })],
      };
      const page = mut.nodes.find((n) => n.kind === 'page')!;
      if (page.kind !== 'page') throw new Error('unreachable');
      page.page.components.push(createForm(api.id, []));
    });
    const issues = issuesOf(ir, 'L005');
    expect(issues.length).toBe(1);
    expect(issues[0]!.fix?.kind).toBe('bindField');
  });

  it('readOnly 必填字段不要求控件', () => {
    const ir = withFixture((mut) => {
      const api = mut.nodes.find((n) => n.kind === 'api')!;
      if (api.kind !== 'api') throw new Error('unreachable');
      api.api.requestBody = {
        shape: 'object',
        required: true,
        contentType: 'application/json',
        fields: [createField({ name: 'deviceId', type: 'string', required: true, readOnly: true })],
      };
      const page = mut.nodes.find((n) => n.kind === 'page')!;
      if (page.kind !== 'page') throw new Error('unreachable');
      page.page.components.push(createForm(api.id, []));
    });
    expect(issuesOf(ir, 'L005')).toEqual([]);
  });
});

describe('L006 path+method 重复', () => {
  it('同 path 同 method 报 error', () => {
    const ir = withFixture((mut) => {
      const api = mut.nodes.find((n) => n.kind === 'api')!;
      if (api.kind !== 'api') throw new Error('unreachable');
      mut.nodes.push(
        createApiNode({
          name: '重复列表',
          codeName: 'listDevicesDup',
          canvasId: api.canvasId,
          api: {
            method: api.api.method,
            path: api.api.path,
            summary: '重复',
            tags: [],
            auth: 'none',
            pathParams: [],
            query: [],
            headers: [],
            responses: [{ status: 200, description: 'OK', fields: [], shape: 'array' }],
          },
        }),
      );
    });
    const issues = issuesOf(ir, 'L006');
    expect(issues.length).toBe(1);
    expect(issues[0]!.severity).toBe('error');
  });

  it('同 path 不同 method 不报', () => {
    const ir = withFixture((mut) => {
      const api = mut.nodes.find((n) => n.kind === 'api')!;
      if (api.kind !== 'api') throw new Error('unreachable');
      mut.nodes.push(
        createApiNode({
          name: '新建',
          codeName: 'createDevice',
          canvasId: api.canvasId,
          api: {
            method: 'PATCH',
            path: api.api.path,
            summary: '新建',
            tags: [],
            auth: 'none',
            pathParams: [],
            query: [],
            headers: [],
            responses: [{ status: 201, description: 'Created', fields: [], shape: 'object' }],
          },
        }),
      );
    });
    expect(issuesOf(ir, 'L006')).toEqual([]);
  });
});

describe('L007 列表接口缺分页', () => {
  it('返回数组但无分页参数报 warn 并给修复', () => {
    const ir = withFixture((mut) => {
      const api = mut.nodes.find((n) => n.kind === 'api')!;
      if (api.kind !== 'api') throw new Error('unreachable');
      api.api.query = [];
      api.api.responses = [{ status: 200, description: 'OK', fields: [], shape: 'array' }];
    });
    const issues = issuesOf(ir, 'L007');
    expect(issues.length).toBe(1);
    expect(issues[0]!.fix).toEqual({ kind: 'addPaginationParams', apiNodeId: expect.any(String) });
  });

  it('已声明 page/pageSize 不报', () => {
    const ir = withFixture((mut) => {
      const api = mut.nodes.find((n) => n.kind === 'api')!;
      if (api.kind !== 'api') throw new Error('unreachable');
      api.api.query = [
        createField({ name: 'page', type: 'integer' }),
        createField({ name: 'pageSize', type: 'integer' }),
      ];
      api.api.responses = [{ status: 200, description: 'OK', fields: [], shape: 'array' }];
    });
    expect(issuesOf(ir, 'L007')).toEqual([]);
  });

  it('非 GET 不检查', () => {
    const ir = withFixture((mut) => {
      const api = mut.nodes.find((n) => n.kind === 'api')!;
      if (api.kind !== 'api') throw new Error('unreachable');
      api.api.method = 'POST';
      api.api.query = [];
      api.api.responses = [{ status: 200, description: 'OK', fields: [], shape: 'array' }];
    });
    expect(issuesOf(ir, 'L007')).toEqual([]);
  });
});

describe('L008 枚举缺取值范围', () => {
  it('既无 enumRef 也无内联值报 error', () => {
    const ir = withFixture((mut) => {
      const table = mut.nodes.find((n) => n.kind === 'table')!;
      if (table.kind !== 'table') throw new Error('unreachable');
      table.table.fields.push(createField({ name: 'kind', type: 'enum' }));
    });
    const issues = issuesOf(ir, 'L008');
    expect(issues.length).toBe(1);
    expect(issues[0]!.fix?.kind).toBe('addEnumValues');
  });

  it('有内联值不报', () => {
    const ir = withFixture((mut) => {
      const table = mut.nodes.find((n) => n.kind === 'table')!;
      if (table.kind !== 'table') throw new Error('unreachable');
      table.table.fields.push(createField({ name: 'kind', type: 'enum', constraints: { enumValues: ['A', 'B'] } }));
    });
    expect(issuesOf(ir, 'L008')).toEqual([]);
  });

  it('enumRef 指向不存在的字典仍然报错', () => {
    const ir = withFixture((mut) => {
      const table = mut.nodes.find((n) => n.kind === 'table')!;
      if (table.kind !== 'table') throw new Error('unreachable');
      table.table.fields.push(createField({ name: 'kind', type: 'enum', constraints: { enumRef: 'en_MISSING' } }));
    });
    expect(issuesOf(ir, 'L008').length).toBe(1);
  });
});

describe('L009 自引用无深度上限', () => {
  it('自引用外键报 info', () => {
    const ir = withFixture((mut) => {
      const table = mut.nodes.find((n) => n.kind === 'table')!;
      if (table.kind !== 'table') throw new Error('unreachable');
      const parent = createField({ name: 'parentId', type: 'ref', constraints: { ref: { tableId: table.id } } });
      table.table.fields.push(parent);
    });
    const issues = issuesOf(ir, 'L009');
    expect(issues.length).toBe(1);
    expect(issues[0]!.severity).toBe('info');
  });

  it('普通外键不报', () => {
    const { ir } = buildFixture();
    expect(issuesOf(ir, 'L009')).toEqual([]);
  });
});

describe('L010 命名规范', () => {
  it('表名非 snake_case 报 warn 并给重命名修复', () => {
    const ir = withFixture((mut) => {
      const table = mut.nodes.find((n) => n.kind === 'table')!;
      if (table.kind !== 'table') throw new Error('unreachable');
      table.table.dbName = 'DeviceTable';
    });
    const issues = issuesOf(ir, 'L010').filter((i) => i.message.includes('表名'));
    expect(issues.length).toBe(1);
    expect(issues[0]!.fix).toEqual(expect.objectContaining({ kind: 'renameNode', to: 'device_table' }));
  });

  it('字段名非 camelCase 报 warn', () => {
    const ir = withFixture((mut) => {
      const table = mut.nodes.find((n) => n.kind === 'table')!;
      if (table.kind !== 'table') throw new Error('unreachable');
      table.table.fields.push(createField({ name: 'snake_case_name', type: 'string' }));
    });
    const issues = issuesOf(ir, 'L010').filter((i) => i.message.includes('camelCase'));
    expect(issues.length).toBe(1);
  });

  it('路径片段非 kebab-case 报 warn', () => {
    const ir = withFixture((mut) => {
      const api = mut.nodes.find((n) => n.kind === 'api')!;
      if (api.kind !== 'api') throw new Error('unreachable');
      api.api.path = '/Device_List';
    });
    expect(issuesOf(ir, 'L010').some((i) => i.message.includes('kebab-case'))).toBe(true);
  });

  it('路径未以 / 开头报 warn', () => {
    const ir = withFixture((mut) => {
      const api = mut.nodes.find((n) => n.kind === 'api')!;
      if (api.kind !== 'api') throw new Error('unreachable');
      api.api.path = 'devices';
    });
    expect(issuesOf(ir, 'L010').some((i) => i.message.includes('以 / 开头'))).toBe(true);
  });
});

describe('L011 路径参数声明', () => {
  it('路径里有 {id} 但未声明报 error', () => {
    const ir = withFixture((mut) => {
      const api = mut.nodes.find((n) => n.kind === 'api')!;
      if (api.kind !== 'api') throw new Error('unreachable');
      api.api.path = '/devices/{id}';
      api.api.pathParams = [];
    });
    const issues = issuesOf(ir, 'L011');
    expect(issues.length).toBe(1);
    expect(issues[0]!.message).toContain('{id}');
  });

  it('声明了但路径里没有也报 error', () => {
    const ir = withFixture((mut) => {
      const api = mut.nodes.find((n) => n.kind === 'api')!;
      if (api.kind !== 'api') throw new Error('unreachable');
      api.api.path = '/devices';
      api.api.pathParams = [createField({ name: 'id', type: 'string' })];
    });
    expect(issuesOf(ir, 'L011').some((i) => i.message.includes('路径里没有'))).toBe(true);
  });

  it('声明与路径一致时不报', () => {
    const ir = withFixture((mut) => {
      const api = mut.nodes.find((n) => n.kind === 'api')!;
      if (api.kind !== 'api') throw new Error('unreachable');
      api.api.path = '/devices/{id}';
      api.api.pathParams = [createField({ name: 'id', type: 'string', required: true })];
    });
    expect(issuesOf(ir, 'L011')).toEqual([]);
  });
});

describe('L012 页面路由重复', () => {
  it('两个页面同路由报 error 并给改路由修复', () => {
    const ir = withFixture((mut) => {
      const page = mut.nodes.find((n) => n.kind === 'page')!;
      if (page.kind !== 'page') throw new Error('unreachable');
      const dup = createPageNode({ name: '重复页', codeName: 'Dup', canvasId: page.canvasId });
      dup.page.route = page.page.route;
      mut.nodes.push(dup);
    });
    const issues = issuesOf(ir, 'L012');
    expect(issues.length).toBe(1);
    expect(issues[0]!.fix).toEqual(expect.objectContaining({ kind: 'setRoute' }));
  });

  it('路由不同不报', () => {
    const { ir } = buildFixture();
    expect(issuesOf(ir, 'L012')).toEqual([]);
  });
});

describe('L013 契约认证与项目设置不一致', () => {
  it('接口 auth=bearer 但项目 auth=none 报 warn', () => {
    const ir = withFixture((mut) => {
      mut.settings.backend.auth = 'none';
      const api = mut.nodes.find((n) => n.kind === 'api')!;
      if (api.kind !== 'api') throw new Error('unreachable');
      api.api.auth = 'bearer';
    });
    const issues = issuesOf(ir, 'L013');
    expect(issues.length).toBe(1);
    expect(issues[0]!.severity).toBe('warn');
  });

  it('项目启用 bearer 时不报', () => {
    const ir = withFixture((mut) => {
      mut.settings.backend.auth = 'jwt';
      const api = mut.nodes.find((n) => n.kind === 'api')!;
      if (api.kind !== 'api') throw new Error('unreachable');
      api.api.auth = 'bearer';
    });
    expect(issuesOf(ir, 'L013')).toEqual([]);
  });
});

describe('L014 组件绑定字段不在 DTO 中', () => {
  it('绑了接口里不存在的字段报 warn', () => {
    const ir = withFixture((mut) => {
      const api = mut.nodes.find((n) => n.kind === 'api')!;
      const page = mut.nodes.find((n) => n.kind === 'page')!;
      if (api.kind !== 'api' || page.kind !== 'page') throw new Error('unreachable');
      // 字段表里存在，但那接口的 DTO 里没有
      const stray = createField({ name: 'strayField', type: 'string' });
      const table = mut.nodes.find((n) => n.kind === 'table')!;
      if (table.kind === 'table') table.table.fields.push(stray);
      page.page.components.push(createSearchForm(api.id, [{ fieldRef: stray.id }]));
    });
    const issues = issuesOf(ir, 'L014');
    expect(issues.length).toBe(1);
    expect(issues[0]!.message).toContain('strayField');
  });

  it('绑定字段在响应里时不报', () => {
    const { ir } = buildFixture();
    expect(issuesOf(ir, 'L014')).toEqual([]);
  });

  it('字段已从 IR 删除但 binding 残留时报 warn', () => {
    const ir = withFixture((mut) => {
      const api = mut.nodes.find((n) => n.kind === 'api')!;
      const page = mut.nodes.find((n) => n.kind === 'page')!;
      if (api.kind !== 'api' || page.kind !== 'page') throw new Error('unreachable');
      page.page.components.push(createSearchForm(api.id, [{ fieldRef: 'fd_DELETEDFIELD' }]));
    });
    const issues = issuesOf(ir, 'L014');
    expect(issues.length).toBe(1);
    expect(issues[0]!.message).toContain('已不存在的字段');
  });
});

// ────────────────────────────── 引擎行为 ──────────────────────────────

describe('引擎：严重度覆盖与忽略', () => {
  it('overrides 可提升为 error', () => {
    const ir = withFixture((mut) => {
      const page = mut.nodes.find((n) => n.kind === 'page')!;
      if (page.kind !== 'page') throw new Error('unreachable');
      page.page.components.push(createAction({ title: '空' }));
    });
    const result = runLint(ir, { overrides: { L001: 'error' } });
    expect(result.issues.find((i) => i.ruleId === 'L001')!.severity).toBe('error');
    expect(result.blocked).toBe(true);
  });

  it("overrides 为 'off' 时该规则完全不跑", () => {
    const ir = withFixture((mut) => {
      const page = mut.nodes.find((n) => n.kind === 'page')!;
      if (page.kind === 'page') page.page.components.push(createAction({ title: '空' }));
    });
    expect(runLint(ir, { overrides: { L001: 'off' } }).issues.filter((i) => i.ruleId === 'L001')).toEqual([]);
  });

  it('IR settings 里的 ruleOverrides 生效', () => {
    const ir = withFixture((mut) => {
      mut.settings.lint.ruleOverrides = { L001: 'error' };
      const page = mut.nodes.find((n) => n.kind === 'page')!;
      if (page.kind === 'page') page.page.components.push(createAction({ title: '空' }));
    });
    expect(runLint(ir).issues.find((i) => i.ruleId === 'L001')!.severity).toBe('error');
  });

  it('忽略项按 targetId 匹配，进 ignored 而不进 issues', () => {
    const ir = withFixture((mut) => {
      const page = mut.nodes.find((n) => n.kind === 'page')!;
      if (page.kind === 'page') page.page.components.push(createAction({ title: '空' }));
    });
    const before = runLint(ir);
    const target = before.issues.find((i) => i.ruleId === 'L001')!;
    const result = runLint(ir, {
      ignores: [{ ruleId: 'L001', targetId: target.target.componentId!, reason: '占位按钮，暂时保留' }],
    });
    expect(result.issues.filter((i) => i.ruleId === 'L001')).toEqual([]);
    expect(result.ignored.filter((i) => i.ruleId === 'L001').length).toBe(1);
  });

  it('IR 里持久化的 ignores 也生效', () => {
    const ir = withFixture((mut) => {
      const page = mut.nodes.find((n) => n.kind === 'page')!;
      if (page.kind === 'page') page.page.components.push(createAction({ title: '空' }));
    });
    const target = runLint(ir).issues.find((i) => i.ruleId === 'L001')!;
    ir.settings.lint.ignores = [{ ruleId: 'L001', targetId: target.target.componentId!, reason: '已知' }];
    expect(runLint(ir).issues.filter((i) => i.ruleId === 'L001')).toEqual([]);
  });

  it('only / except 过滤规则', () => {
    const { ir } = buildFixture();
    expect(runLint(ir, { only: ['L010'] }).issues.every((i) => i.ruleId === 'L010')).toBe(true);
    expect(runLint(ir, { except: ['L010'] }).issues.some((i) => i.ruleId === 'L010')).toBe(false);
  });
});

describe('引擎：排序与统计', () => {
  it('error 排在 warn 前，同级按规则号', () => {
    const ir = withFixture((mut) => {
      const page = mut.nodes.find((n) => n.kind === 'page')!;
      if (page.kind !== 'page') throw new Error('unreachable');
      // 造一个 warn（L001）与一个 error（L008）
      page.page.components.push(createAction({ title: '空' }));
      const table = mut.nodes.find((n) => n.kind === 'table')!;
      if (table.kind === 'table') table.table.fields.push(createField({ name: 'kind', type: 'enum' }));
    });
    const result = runLint(ir);
    const firstError = result.issues.findIndex((i) => i.severity === 'error');
    const firstWarn = result.issues.findIndex((i) => i.severity === 'warn');
    expect(firstError).toBeLessThan(firstWarn);
  });

  it('stats 计数与 issues 一致', () => {
    const { ir } = buildFixture();
    const result = runLint(ir);
    expect(result.stats.error + result.stats.warn + result.stats.info).toBe(result.issues.length);
  });

  it('blockOnError=false 时 error 也不阻断', () => {
    const ir = withFixture((mut) => {
      mut.settings.lint.blockOnError = false;
      const table = mut.nodes.find((n) => n.kind === 'table')!;
      if (table.kind === 'table') table.table.fields.push(createField({ name: 'kind', type: 'enum' }));
    });
    const result = runLint(ir);
    expect(result.stats.error).toBeGreaterThan(0);
    expect(result.blocked).toBe(false);
  });

  it('结果稳定：两次运行完全一致', () => {
    const { ir } = buildFixture();
    expect(JSON.stringify(runLint(ir))).toBe(JSON.stringify(runLint(ir)));
  });

  it('空 IR 不报错', () => {
    const ir = createEmptyIR({ projectName: 'Empty' });
    const result = runLint(ir);
    expect(result.issues).toEqual([]);
    expect(result.blocked).toBe(false);
  });
});

describe('辅助输出', () => {
  it('groupByTarget 按 nodeId 分组', () => {
    const ir = withFixture((mut) => {
      const page = mut.nodes.find((n) => n.kind === 'page')!;
      if (page.kind === 'page') page.page.components.push(createAction({ title: '空' }));
    });
    const grouped = groupByTarget(runLint(ir));
    expect(grouped.size).toBeGreaterThan(0);
    for (const [key, list] of grouped) {
      expect(key.length).toBeGreaterThan(0);
      expect(list.length).toBeGreaterThan(0);
    }
  });

  it('toSarif 产出 2.1.0 结构且规则表完整', () => {
    const { ir } = buildFixture();
    const sarif = toSarif(runLint(ir)) as {
      version: string;
      runs: Array<{ tool: { driver: { rules: unknown[] } }; results: unknown[] }>;
    };
    expect(sarif.version).toBe('2.1.0');
    expect(sarif.runs[0]!.tool.driver.rules.length).toBe(LINT_RULES.length);
    expect(Array.isArray(sarif.runs[0]!.results)).toBe(true);
  });

  it('toSarif 把 error 映射为 level=error', () => {
    const ir = withFixture((mut) => {
      const table = mut.nodes.find((n) => n.kind === 'table')!;
      if (table.kind === 'table') table.table.fields.push(createField({ name: 'kind', type: 'enum' }));
    });
    const sarif = toSarif(runLint(ir)) as { runs: Array<{ results: Array<{ level: string }> }> };
    expect(sarif.runs[0]!.results.some((r) => r.level === 'error')).toBe(true);
  });
});

void createTable;
