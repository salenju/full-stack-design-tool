import { hashRegion } from '@fsdt/core-ir';
import { describe, expect, it } from 'vitest';

import { regionEnd, regionStart, wrapRegion } from '../src/markers.js';
import { mergeRegions, regionsOf } from '../src/merge.js';

/** 拼一个「服务文件」：header + 方法体区块，方便逐项改一边做三方合并 */
function serviceFile(options: {
  header: string;
  body: string;
  mode?: 'generated' | 'todo' | 'handwritten';
  name?: string;
  extra?: string;
}): string {
  const name = options.name ?? 'listDevices';
  const mode = options.mode ?? 'todo';
  const marker = { start: regionStart('ts', name, options.body, mode), end: regionEnd('ts', name, mode) };
  return [
    `// @dsg:generated file=svc.ts ir=${options.header}`,
    'export class DevicesService {',
    '  async listDevices(): Promise<void> {',
    `    ${marker.start}`,
    ...options.body.split('\n').map((l) => `    ${l}`),
    `    ${marker.end}`,
    '  }',
    options.extra ?? '',
    '}',
    '',
  ].join('\n');
}

describe('mergeRegions：todo 区块', () => {
  it('保留用户实现，同时换成新的骨架', () => {
    const next = serviceFile({ header: 'aaa', body: "throw new Error('未实现');" });
    // 用户把方法体实现掉了（磁盘上的标记哈希也随之变化）
    const disk = serviceFile({ header: 'aaa', body: 'return db.findMany();' });
    // 契约变了：文件头哈希与新增一行代码都不同
    const changed = serviceFile({ header: 'bbb', body: "throw new Error('未实现');" }).replace(
      '  async listDevices',
      '  // 新增：分页参数\n  async listDevices',
    );

    const result = mergeRegions(changed, disk, regionsOf(next));
    expect(result.status).toBe('merged');
    expect(result.content).toContain('return db.findMany();');
    expect(result.content).toContain('// 新增：分页参数');
    expect(result.content).toContain('ir=bbb');
    expect(result.content).not.toContain("throw new Error('未实现');");
    expect(result.kept).toContain('listDevices');
  });

  it('内容没变时判定 unchanged，不产生无谓写盘', () => {
    const next = serviceFile({ header: 'aaa', body: 'return 1;' });
    const disk = serviceFile({ header: 'aaa', body: 'return 1;' });
    expect(mergeRegions(next, disk, regionsOf(next)).status).toBe('unchanged');
  });

  it('只改了区块内容时，合并结果与磁盘逐字节相同（不会误报漂移）', () => {
    const next = serviceFile({ header: 'aaa', body: "throw new Error('x');" });
    const disk = serviceFile({ header: 'aaa', body: 'return done();' });
    const result = mergeRegions(next, disk, regionsOf(next));
    // 这一步决定了 `gen --check` 会不会在用户写了业务逻辑后永久红灯
    expect(result.status).toBe('unchanged');
    expect(result.content).toBe(disk);
  });
});

describe('mergeRegions：generated 区块', () => {
  it('用户没改过 → 换成新内容', () => {
    const next = serviceFile({ header: 'aaa', body: 'const columns = [1];', mode: 'generated' });
    const disk = serviceFile({ header: 'aaa', body: 'const columns = [1];', mode: 'generated' }).replace(
      'ir=aaa',
      'ir=old',
    );
    const result = mergeRegions(next, disk, regionsOf(next));
    expect(result.status).toBe('merged');
    expect(result.content).toContain('const columns = [1];');
  });

  it('用户改过 → 冲突，且返回磁盘原文（绝不写盘覆盖）', () => {
    const next = serviceFile({ header: 'aaa', body: 'const columns = [1];', mode: 'generated' });
    const disk = serviceFile({ header: 'aaa', body: 'const columns = [1, 2];', mode: 'generated' });
    // 基线按「上次生成的样子」给：用户改动后哈希对不上
    const base = regionsOf(next);
    const result = mergeRegions(next, disk, base);
    expect(result.status).toBe('conflict');
    expect(result.content).toBe(disk);
    expect(result.conflicts).toEqual([{ region: 'listDevices', reason: 'edited-generated' }]);
  });

  it('没有基线哈希时也按冲突处理（不猜谁对）', () => {
    const next = serviceFile({ header: 'aaa', body: 'a', mode: 'generated' });
    const disk = serviceFile({ header: 'aaa', body: 'b', mode: 'generated' });
    expect(mergeRegions(next, disk, []).status).toBe('conflict');
  });

  it('用户把 generated 标记改成 handwritten → 按用户的来', () => {
    const next = serviceFile({ header: 'aaa', body: 'generated();', mode: 'generated' });
    const disk = serviceFile({ header: 'aaa', body: 'mine();', mode: 'handwritten' });
    const result = mergeRegions(next, disk, regionsOf(next));
    expect(result.status).toBe('unchanged');
    expect(result.content).toContain('mine();');
    expect(result.content).toContain('@dsg:handwritten start name=listDevices');
  });
});

describe('mergeRegions：无法合并的情形', () => {
  it('磁盘上没有区块标记 → unmergeable（可能整个文件被重写过）', () => {
    const next = serviceFile({ header: 'aaa', body: 'x' });
    const disk = '// 我重写了整个文件\n';
    const result = mergeRegions(next, disk, []);
    expect(result.status).toBe('unmergeable');
    expect(result.content).toBe(disk);
  });

  it('生成内容里没有区块 → unmergeable', () => {
    expect(mergeRegions('const a = 1;\n', 'const a = 2;\n', []).status).toBe('unmergeable');
  });

  it('磁盘多出生成器不再产出的区块 → 冲突，不猜该挪到哪', () => {
    const next = serviceFile({ header: 'aaa', body: 'x' });
    const disk = `${serviceFile({ header: 'aaa', body: 'x' })}\n${wrapRegion('ts', 'myHelper', 'export function helper() {}')}\n`;
    const result = mergeRegions(next, disk, regionsOf(next));
    expect(result.status).toBe('conflict');
    expect(result.conflicts.some((c) => c.region === 'myHelper' && c.reason === 'removed-region')).toBe(true);
  });
});

describe('regionsOf', () => {
  it('读出区块名、模式与内容哈希', () => {
    const content = serviceFile({ header: 'aaa', body: '    return 1;' });
    const regions = regionsOf(content);
    expect(regions).toHaveLength(1);
    expect(regions[0]).toEqual({
      name: 'listDevices',
      mode: 'todo',
      hash: hashRegion('    return 1;'),
    });
  });

  it('无区块的文件返回空数组（manifest 里就不写 regions）', () => {
    expect(regionsOf('const a = 1;\n')).toEqual([]);
  });
});
