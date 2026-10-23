import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildFixture } from '@fsdt/core-ir/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { startServer, type RunningServer } from '../src/http.js';

let running: RunningServer | undefined;

async function boot(): Promise<RunningServer> {
  const home = await mkdtemp(join(tmpdir(), 'fsdt-http-'));
  const server = await startServer({ home, port: 0 });
  running = server;
  return server;
}

afterEach(async () => {
  await running?.close();
  running = undefined;
});

describe('服务模式 HTTP', () => {
  it('健康检查与项目列表', async () => {
    const server = await boot();
    const health = await fetch(`${server.url}/api/health`);
    expect(health.status).toBe(200);
    expect((await health.json()) as { ok: boolean }).toMatchObject({ ok: true });

    const empty = await fetch(`${server.url}/api/projects`);
    expect((await empty.json()) as { projects: unknown[] }).toMatchObject({ projects: [] });
  });

  it('建项目 → 读 IR → 建快照，链路通', async () => {
    const server = await boot();
    const created = await fetch(`${server.url}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '设备管理' }),
    });
    expect(created.status).toBe(201);
    const { project } = (await created.json()) as { project: { id: string } };

    const ir = await fetch(`${server.url}/api/projects/${project.id}/ir`);
    expect(ir.status).toBe(200);
    const body = (await ir.json()) as { ir: { project: { name: string } }; schemaHash: string };
    expect(body.ir.project.name).toBe('设备管理');
    expect(body.schemaHash.length).toBeGreaterThan(0);

    const snap = await fetch(`${server.url}/api/projects/${project.id}/snapshots`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: '第一版' }),
    });
    expect(snap.status).toBe(201);

    const list = await fetch(`${server.url}/api/projects/${project.id}/snapshots`);
    expect(((await list.json()) as { snapshots: unknown[] }).snapshots).toHaveLength(1);
  });

  it('写画布必须带 If-Match：缺了 428，旧版本 409', async () => {
    const server = await boot();
    const project = await server.store.createProject({ name: '设备管理', ir: buildFixture().ir });
    const { ir, schemaHash } = await server.store.readIR(project.id);
    const canvas = ir.canvases[0]!;
    const doc = {
      canvas: { ...canvas, name: 'HTTP 改的画布' },
      nodes: ir.nodes.filter((n) => n.canvasId === canvas.id),
      edges: ir.edges.filter((e) => e.canvasId === canvas.id),
    };

    const noMatch = await fetch(`${server.url}/api/projects/${project.id}/canvases/${canvas.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(doc),
    });
    expect(noMatch.status).toBe(428);

    const stale = await fetch(`${server.url}/api/projects/${project.id}/canvases/${canvas.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'If-Match': 'sha256:stale' },
      body: JSON.stringify(doc),
    });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { latestHash: string }).latestHash).toBe(schemaHash);

    const ok = await fetch(`${server.url}/api/projects/${project.id}/canvases/${canvas.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'If-Match': schemaHash },
      body: JSON.stringify(doc),
    });
    expect(ok.status).toBe(200);
    const after = await server.store.readIR(project.id);
    expect(after.ir.canvases[0]?.name).toBe('HTTP 改的画布');
  });

  it('lint 与 compile 返回结构化结果', async () => {
    const server = await boot();
    const project = await server.store.createProject({ name: '设备管理', ir: buildFixture().ir });

    const lint = await fetch(`${server.url}/api/projects/${project.id}/lint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(lint.status).toBe(200);
    expect(((await lint.json()) as { issues: unknown[] }).issues).toBeInstanceOf(Array);

    const compile = await fetch(`${server.url}/api/projects/${project.id}/compile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(compile.status).toBe(200);
    const body = (await compile.json()) as { openapi: { json: { paths: Record<string, unknown> } } };
    expect(Object.keys(body.openapi.json.paths).length).toBeGreaterThan(0);
  });

  it('生成是异步任务：建任务 → 轮询到完成 → 产物可打包下载', async () => {
    const server = await boot();
    const project = await server.store.createProject({ name: '设备管理', ir: buildFixture().ir });

    const started = await fetch(`${server.url}/api/projects/${project.id}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targets: ['vue'] }),
    });
    expect(started.status).toBe(202);
    const { jobId } = (await started.json()) as { jobId: string };

    // 轮询到结束
    let state = '';
    for (let i = 0; i < 100 && state !== 'done' && state !== 'error'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const job = await fetch(`${server.url}/api/jobs/${jobId}`);
      state = ((await job.json()) as { job: { state: string } }).job.state;
    }
    expect(state).toBe('done');

    const zip = await fetch(`${server.url}/api/projects/${project.id}/download`);
    expect(zip.status).toBe(200);
    expect(zip.headers.get('content-type')).toBe('application/zip');
    const bytes = new Uint8Array(await zip.arrayBuffer());
    // ZIP 魔数：PK\x03\x04
    expect([...bytes.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });

  it('SSE 能把任务事件补齐（先连上也不丢事件）', async () => {
    const server = await boot();
    const project = await server.store.createProject({ name: '设备管理', ir: buildFixture().ir });
    const started = await fetch(`${server.url}/api/projects/${project.id}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targets: ['vue'] }),
    });
    const { jobId } = (await started.json()) as { jobId: string };

    const events = await fetch(`${server.url}/api/jobs/${jobId}/events?from=0`);
    expect(events.headers.get('content-type')).toContain('text/event-stream');
    const text = await events.text();
    expect(text).toContain('job.created');
    expect(text).toContain('job.done');
  });

  it('未知端点 404，方法不对 405', async () => {
    const server = await boot();
    const notFound = await fetch(`${server.url}/api/nope`);
    expect(notFound.status).toBe(404);

    const wrongMethod = await fetch(`${server.url}/api/health`, { method: 'POST' });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get('allow')).toContain('GET');
  });
});
