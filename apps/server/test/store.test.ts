import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildFixture } from '@fsdt/core-ir/testing';
import { saveIR } from '@fsdt/core-ir';
import { describe, expect, it } from 'vitest';

import { ProjectStore, VersionConflictError } from '../src/store.js';

async function newStore(): Promise<{ store: ProjectStore; home: string }> {
  const home = await mkdtemp(join(tmpdir(), 'fsdt-store-'));
  const store = new ProjectStore(home);
  await store.init();
  return { store, home };
}

describe('ProjectStore：托管项目', () => {
  it('新建项目后能读回 IR，画布按画布拆成独立文件', async () => {
    const { store } = await newStore();
    const fixture = buildFixture();
    const project = await store.createProject({ name: '设备管理', ir: fixture.ir });

    const { ir, schemaHash } = await store.readIR(project.id);
    expect(ir.project.name).toBe('设备管理');
    expect(ir.canvases.length).toBe(fixture.ir.canvases.length);
    expect(ir.nodes.length).toBe(fixture.ir.nodes.length);
    expect(schemaHash.startsWith('sha256:')).toBe(true);

    // 画布文件是拆开的：按 canvasId 一个文件
    const canvas = fixture.ir.canvases[0]!;
    const doc = await store.readCanvas(project.id, canvas.id);
    expect(doc.canvas.id).toBe(canvas.id);
    expect(doc.nodes.length).toBe(fixture.ir.nodes.filter((n) => n.canvasId === canvas.id).length);
  });

  it('写画布要带对的版本号，版本不对就拒绝', async () => {
    const { store } = await newStore();
    const project = await store.createProject({ name: '设备管理', ir: buildFixture().ir });
    const { ir, schemaHash } = await store.readIR(project.id);
    const canvas = ir.canvases[0]!;

    const doc = {
      canvas: { ...canvas, name: '改过的画布' },
      nodes: ir.nodes.filter((n) => n.canvasId === canvas.id),
      edges: ir.edges.filter((e) => e.canvasId === canvas.id),
    };

    // 不带版本号 → 拒绝（静默覆盖是最不可接受的故障）
    await expect(store.writeCanvas(project.id, canvas.id, doc, undefined)).rejects.toBeInstanceOf(VersionConflictError);
    // 版本号不对 → 拒绝
    await expect(store.writeCanvas(project.id, canvas.id, doc, 'sha256:stale')).rejects.toBeInstanceOf(VersionConflictError);

    const saved = await store.writeCanvas(project.id, canvas.id, doc, schemaHash);
    const after = await store.readIR(project.id);
    expect(after.ir.canvases[0]?.name).toBe('改过的画布');
    expect(after.schemaHash).toBe(saved.schemaHash);
  });

  it('写画布前做完整 IR 校验：跨画布重复的字段 ID 会被拦下', async () => {
    const { store } = await newStore();
    const project = await store.createProject({ name: '设备管理', ir: buildFixture().ir });
    const { ir, schemaHash } = await store.readIR(project.id);
    const canvas = ir.canvases[0]!;

    // 复制一个表节点：字段 ID 与原来的重复 → IR002
    const nodes = ir.nodes.filter((n) => n.canvasId === canvas.id);
    const dup = nodes.map((n) => ({ ...n, id: `${n.id}_dup` }));
    const doc = { canvas, nodes: [...nodes, ...dup], edges: [] };

    await expect(store.writeCanvas(project.id, canvas.id, doc, schemaHash)).rejects.toThrow(/校验失败/);
  });

  it('快照能建能列，回滚后内容与快照一致', async () => {
    const { store } = await newStore();
    const project = await store.createProject({ name: '设备管理', ir: buildFixture().ir });
    const before = await store.readIR(project.id);

    const snapshot = await store.createSnapshot(project.id, '改名前');
    expect(store.listSnapshots(project.id)).toHaveLength(1);

    // 改一下再回滚
    const canvas = before.ir.canvases[0]!;
    await store.writeCanvas(
      project.id,
      canvas.id,
      {
        canvas: { ...canvas, name: '改过的画布' },
        nodes: before.ir.nodes.filter((n) => n.canvasId === canvas.id),
        edges: before.ir.edges.filter((e) => e.canvasId === canvas.id),
      },
      before.schemaHash,
    );
    expect((await store.readIR(project.id)).ir.canvases[0]?.name).toBe('改过的画布');

    const restored = await store.restoreSnapshot(project.id, snapshot.id);
    expect(restored.schemaHash).toBe(before.schemaHash);
    expect((await store.readIR(project.id)).ir.canvases[0]?.name).toBe(canvas.name);
  });
});

describe('ProjectStore：链接仓库（文件模式）', () => {
  it('link 之后写画布落到仓库文件里，不另存一份', async () => {
    const { store } = await newStore();
    const repo = await mkdtemp(join(tmpdir(), 'fsdt-repo-'));
    const designDir = join(repo, 'design');
    await mkdir(designDir, { recursive: true });
    await saveIR(join(designDir, 'ir.json'), buildFixture().ir);

    const project = await store.linkDirectory(designDir, '仓库项目');
    expect(project.mode).toBe('file');
    expect(project.sourcePath).toBe(designDir);

    const { ir, schemaHash } = await store.readIR(project.id);
    const canvas = ir.canvases[0]!;
    await store.writeCanvas(
      project.id,
      canvas.id,
      {
        canvas: { ...canvas, name: '仓库里的画布' },
        nodes: ir.nodes.filter((n) => n.canvasId === canvas.id),
        edges: ir.edges.filter((e) => e.canvasId === canvas.id),
      },
      schemaHash,
    );

    // 权威存储仍是仓库里的文件
    const onDisk = await readFile(join(designDir, 'ir.json'), 'utf8');
    expect(onDisk).toContain('仓库里的画布');
  });

  it('重复 link 同一目录是幂等的（不会多出一条同名项目）', async () => {
    const { store } = await newStore();
    const repo = await mkdtemp(join(tmpdir(), 'fsdt-repo-'));
    const designDir = join(repo, 'design');
    await mkdir(designDir, { recursive: true });
    await saveIR(join(designDir, 'ir.json'), buildFixture().ir);

    const first = await store.linkDirectory(designDir);
    const second = await store.linkDirectory(designDir);
    expect(second.id).toBe(first.id);
    expect(store.listProjects().filter((p) => p.mode === 'file')).toHaveLength(1);
  });

  it('目录里没有 ir.json 时明确报错', async () => {
    const { store } = await newStore();
    const empty = await mkdtemp(join(tmpdir(), 'fsdt-empty-'));
    await expect(store.linkDirectory(empty)).rejects.toThrow(/ir\.json/);
  });
});

describe('ProjectStore：删除', () => {
  it('删托管项目会清目录，删链接项目只摘索引不碰仓库', async () => {
    const { store } = await newStore();
    const managed = await store.createProject({ name: '托管' });
    await store.deleteProject(managed.id);
    expect(store.listProjects().map((p) => p.id)).not.toContain(managed.id);

    const repo = await mkdtemp(join(tmpdir(), 'fsdt-repo-'));
    const designDir = join(repo, 'design');
    await mkdir(designDir, { recursive: true });
    await saveIR(join(designDir, 'ir.json'), buildFixture().ir);
    const linked = await store.linkDirectory(designDir);
    await store.deleteProject(linked.id);
    // 仓库里的文件必须还在
    const still = await readFile(join(designDir, 'ir.json'), 'utf8');
    expect(still.length).toBeGreaterThan(0);
  });
});
