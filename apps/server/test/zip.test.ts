import { describe, expect, it } from 'vitest';

import { createZip } from '../src/zip.js';

/**
 * 极简 zip 读取器（只支持 store 模式）。
 *
 * 为什么不直接 `unzip -l`：测试要能在任何机器上跑，不能假设系统装了 unzip。
 * 自己按格式读一遍，顺便验证中央目录与本地头是否自洽。
 */
function readZip(buf: Buffer): Map<string, Buffer> {
  const eocdIndex = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocdIndex < 0) throw new Error('没有 EOCD');
  const count = buf.readUInt16LE(eocdIndex + 10);
  let offset = buf.readUInt32LE(eocdIndex + 16);

  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) throw new Error('中央目录签名不对');
    const method = buf.readUInt16LE(offset + 10);
    const size = buf.readUInt32LE(offset + 24);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.subarray(offset + 46, offset + 46 + nameLen).toString('utf8');

    if (method !== 0) throw new Error(`只支持 store 模式，实际 method=${method}`);
    if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('本地头签名不对');
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    out.set(name, buf.subarray(dataStart, dataStart + size));

    offset += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

describe('createZip', () => {
  it('产物是合法的 zip，内容逐字节一致', () => {
    const zip = createZip([
      { path: 'a.txt', data: Buffer.from('hello', 'utf8') },
      { path: 'dir/b.txt', data: Buffer.from('world', 'utf8') },
    ]);
    expect([...zip.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);

    const files = readZip(zip);
    expect([...files.keys()].sort()).toEqual(['a.txt', 'dir/b.txt']);
    expect(files.get('a.txt')?.toString('utf8')).toBe('hello');
    expect(files.get('dir/b.txt')?.toString('utf8')).toBe('world');
  });

  it('空归档也合法（中央目录计数为 0）', () => {
    const zip = createZip([]);
    expect(zip.length).toBe(22);
    expect(readZip(zip).size).toBe(0);
  });

  it('中文文件名按 UTF-8 存（标志位 0x0800）', () => {
    const zip = createZip([{ path: '说明.md', data: Buffer.from('# 标题', 'utf8') }]);
    expect(zip.readUInt16LE(6) & 0x0800).toBe(0x0800);
    expect(readZip(zip).get('说明.md')?.toString('utf8')).toBe('# 标题');
  });
});
