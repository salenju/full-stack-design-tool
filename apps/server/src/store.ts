/**
 * 服务模式的存储层（TD 5.2 模式 A）。
 *
 * ```
 * ~/.fsdt/
 * ├── index.sqlite                 # 项目索引 + 快照元数据
 * └── projects/<id>/
 *     ├── project.json              # 项目元数据 + settings + dictionaries（除画布外的一切）
 *     ├── canvases/<canvasId>.ir.json   # 每个画布一个文件
 *     ├── snapshots/<snapId>.json  # 全量 IR 快照
 *     ├── output/                  # 最近一次生成产物
 *     └── generations/<gid>/       # 历史生成
 * ```
 *
 * 为什么按画布拆文件：单文件在大项目里 diff 噪音太大，而保存时只写变动画布能把
 * 写入量降到 1/N。文件模式（`design/ir.json`）刻意不拆——CI 场景下单一文件更易评审。
 *
 * 模式 B（`fsdt link`）只把 `design/` 目录登记进索引，读写仍落在仓库文件上，
 * 服务不另外存一份——两份存储必然双写冲突。
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import {
  coerceToIR,
  computeSchemaHash,
  createEmptyIR,
  loadIR,
  saveIR,
  serializeIR,
  validateIR,
  type Canvas,
  type IR,
  type IREdge,
  type IRNode,
} from '@fsdt/core-ir';

/** 一个画布文件的内容：画布本身 + 属于它的节点与边 */
export interface CanvasDoc {
  canvas: Canvas;
  nodes: IRNode[];
  edges: IREdge[];
}

export interface ProjectRecord {
  id: string;
  name: string;
  /** managed = 数据在 ~/.fsdt 下；file = 数据在仓库 design/ 下（fsdt link） */
  mode: 'managed' | 'file';
  /** file 模式下的 design/ 目录绝对路径 */
  sourcePath?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SnapshotRecord {
  id: string;
  projectId: string;
  label?: string;
  schemaHash: string;
  createdAt: string;
}

/** 乐观锁冲突：调用方应回 409 并把 latestHash 交回客户端 */
export class VersionConflictError extends Error {
  constructor(
    readonly expected: string,
    readonly latestHash: string,
  ) {
    super(`版本冲突：期望 ${expected}，服务端最新 ${latestHash}`);
    this.name = 'VersionConflictError';
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class ValidationError extends Error {
  constructor(
    message: string,
    readonly problems: string[],
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}

interface ProjectRow {
  id: string;
  name: string;
  mode: string;
  source_path: string | null;
  created_at: string;
  updated_at: string;
}

interface SnapshotRow {
  id: string;
  project_id: string;
  label: string | null;
  schema_hash: string;
  created_at: string;
}

function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

/** project.json 的内容：IR 里除「画布 / 节点 / 边」之外的全部字段 */
interface ProjectFile {
  schemaVersion: 1;
  id: string;
  name: string;
  project: IR['project'];
  dictionaries: IR['dictionaries'];
  assets: IR['assets'];
  settings: IR['settings'];
  meta: IR['meta'];
}

const CANVAS_DIR = 'canvases';
const SNAPSHOT_DIR = 'snapshots';

export class ProjectStore {
  private db: DatabaseSync | null = null;

  constructor(readonly home: string) {}

  get indexPath(): string {
    return join(this.home, 'index.sqlite');
  }

  async init(): Promise<void> {
    await mkdir(join(this.home, 'projects'), { recursive: true });
    this.database();
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  /**
   * 索引库。
   *
   * 用 Node 自带的 `node:sqlite` 而不是 better-sqlite3：后者是原生模块，装它就要
   * 下载预编译包，在 CI 上多一个失败点。代价是这条 API 目前还标着 experimental
   * （Node ≥ 22.5 可用，engines 已经卡在 22.12）。
   */
  private database(): DatabaseSync {
    if (this.db !== null) return this.db;
    const db = new DatabaseSync(this.indexPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        mode TEXT NOT NULL,
        source_path TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS snapshots (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        label TEXT,
        schema_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS snapshots_by_project ON snapshots(project_id, created_at DESC);
    `);
    this.db = db;
    return db;
  }

  // ────────────────────────────── 项目 ──────────────────────────────

  listProjects(): ProjectRecord[] {
    const rows = this.database()
      .prepare('SELECT * FROM projects ORDER BY updated_at DESC')
      .all() as unknown as ProjectRow[];
    return rows.map(toRecord);
  }

  getProject(id: string): ProjectRecord {
    const row = this.database().prepare('SELECT * FROM projects WHERE id = ?').get(id) as unknown as
      | ProjectRow
      | undefined;
    if (row === undefined) throw new NotFoundError(`项目不存在：${id}`);
    return toRecord(row);
  }

  /**
   * 新建托管项目。
   *
   * 种子 IR 一律是空项目，不塞示例：示例数据会让人以为「工具自动建了这些东西」，
   * 然后在删除它们时发现还得先理解 ID 关系。要看示例请用 `scripts/demo/ir.json`。
   */
  async createProject(input: { name: string; ir?: IR }): Promise<ProjectRecord> {
    const id = newId('prj');
    const now = new Date().toISOString();
    const ir = input.ir ?? createEmptyIR({ projectName: input.name });
    ir.project.name = input.name;
    ir.meta.updatedAt = now;

    const dir = this.projectDir(id);
    await mkdir(join(dir, CANVAS_DIR), { recursive: true });
    await mkdir(join(dir, SNAPSHOT_DIR), { recursive: true });
    await writeProjectFile(dir, id, ir);
    await writeCanvasFiles(dir, ir);

    this.database()
      .prepare('INSERT INTO projects (id, name, mode, source_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, input.name, 'managed', null, now, now);
    return this.getProject(id);
  }

  async deleteProject(id: string): Promise<void> {
    const project = this.getProject(id);
    this.database().prepare('DELETE FROM snapshots WHERE project_id = ?').run(id);
    this.database().prepare('DELETE FROM projects WHERE id = ?').run(id);
    // file 模式只摘索引，绝不删用户仓库里的 design/
    if (project.mode === 'managed') await rm(this.projectDir(id), { recursive: true, force: true });
  }

  /**
   * `fsdt link`：把仓库的 `design/` 目录登记为某项目的权威存储。
   *
   * 重复 link 同一目录会返回已有记录（幂等）：否则每次 link 都新建项目，
   * 用户会在项目列表里看到一串同名条目。
   */
  async linkDirectory(designDir: string, name?: string): Promise<ProjectRecord> {
    const existing = this.listProjects().find((p) => p.mode === 'file' && p.sourcePath === designDir);
    if (existing !== undefined) return existing;

    const irPath = join(designDir, 'ir.json');
    if (!existsSync(irPath)) {
      throw new NotFoundError(`目录里没有 ir.json：${irPath}（先在该目录跑 fsdt init）`);
    }
    const { ir } = await loadIR(irPath);
    const now = new Date().toISOString();
    const id = newId('prj');
    this.database()
      .prepare('INSERT INTO projects (id, name, mode, source_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, name ?? ir.project.name, 'file', designDir, now, now);
    // 仓库侧留一份指向，便于「这个 design/ 属于哪个项目」反查
    await writeFile(
      join(designDir, 'project.json'),
      `${JSON.stringify({ id, name: name ?? ir.project.name, linkedAt: now }, null, 2)}\n`,
      'utf8',
    );
    return this.getProject(id);
  }

  projectDir(id: string): string {
    return join(this.home, 'projects', id);
  }

  outputDir(id: string): string {
    return join(this.projectDir(id), 'output');
  }

  generationDir(id: string, generationId: string): string {
    return join(this.projectDir(id), 'generations', generationId);
  }

  // ────────────────────────────── IR ──────────────────────────────

  async readIR(id: string): Promise<{ ir: IR; schemaHash: string }> {
    const project = this.getProject(id);
    const ir =
      project.mode === 'file' ? (await loadIR(join(project.sourcePath!, 'ir.json'))).ir : await readManagedIR(this.projectDir(id));
    return { ir, schemaHash: computeSchemaHash(ir) };
  }

  async readCanvas(id: string, canvasId: string): Promise<CanvasDoc> {
    const { ir } = await this.readIR(id);
    const canvas = ir.canvases.find((c) => c.id === canvasId);
    if (canvas === undefined) throw new NotFoundError(`画布不存在：${canvasId}`);
    return {
      canvas,
      nodes: ir.nodes.filter((n) => n.canvasId === canvasId),
      edges: ir.edges.filter((e) => e.canvasId === canvasId),
    };
  }

  /**
   * 写单个画布。
   *
   * `expectedHash` 是乐观锁：给了就对，不匹配抛 `VersionConflictError`；
   * 不给也拒绝（428 由 HTTP 层翻）——静默覆盖多人编辑是这类工具最不可接受的故障。
   *
   * 落盘前做**完整 IR 校验**（含跨画布的 ID 唯一性）：只校验这一个画布是不够的，
   * IR002 说的就是「字段 ID 全局唯一」，重复 ID 往往跨画布出现。
   */
  async writeCanvas(
    id: string,
    canvasId: string,
    doc: unknown,
    expectedHash: string | undefined,
  ): Promise<{ schemaHash: string; bytes: number }> {
    const { ir } = await this.readIR(id);
    const next = applyCanvasDoc(ir, canvasId, doc);
    return this.writeIR(id, next, expectedHash);
  }

  /**
   * 整份 IR 落盘（一次校验、一次锁检查）。
   *
   * 批量修改（一键修复、快照回滚）必须走这里：逐个画布调 `writeCanvas` 会在第一次
   * 写入后让 schemaHash 变化，第二次就自己和自己冲突。
   */
  async writeIR(
    id: string,
    ir: IR,
    expectedHash: string | undefined,
  ): Promise<{ schemaHash: string; bytes: number }> {
    const project = this.getProject(id);
    const current = await this.readIR(id);
    if (expectedHash === undefined) throw new VersionConflictError('<missing>', current.schemaHash);
    if (expectedHash !== current.schemaHash) throw new VersionConflictError(expectedHash, current.schemaHash);

    const problems = validateIR(ir).filter((d) => d.severity === 'error');
    if (problems.length > 0) {
      throw new ValidationError(
        `IR 校验失败（${problems.length} 个错误），已拒绝写入`,
        problems.map((d) => `[${d.code}] ${d.message}`),
      );
    }
    const next: IR = { ...ir, meta: { ...ir.meta, updatedAt: new Date().toISOString() } };

    if (project.mode === 'file') {
      await saveIR(join(project.sourcePath!, 'ir.json'), next);
    } else {
      const dir = this.projectDir(id);
      await writeProjectFile(dir, id, next);
      await writeCanvasFiles(dir, next);
    }
    this.touch(id, next);
    return { schemaHash: computeSchemaHash(next), bytes: Buffer.byteLength(serializeIR(next)) };
  }

  // ────────────────────────────── 快照 ──────────────────────────────

  listSnapshots(id: string): SnapshotRecord[] {
    this.getProject(id);
    const rows = this.database()
      .prepare('SELECT * FROM snapshots WHERE project_id = ? ORDER BY created_at DESC')
      .all(id) as unknown as SnapshotRow[];
    return rows.map((r) => ({
      id: r.id,
      projectId: r.project_id,
      ...(r.label !== null ? { label: r.label } : {}),
      schemaHash: r.schema_hash,
      createdAt: r.created_at,
    }));
  }

  async createSnapshot(id: string, label?: string): Promise<SnapshotRecord> {
    const { ir, schemaHash } = await this.readIR(id);
    const snapId = `snap_${Date.now().toString(36)}_${randomUUID().slice(0, 6)}`;
    const createdAt = new Date().toISOString();
    const dir = join(this.projectDir(id), SNAPSHOT_DIR);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${snapId}.json`), `${JSON.stringify(ir, null, 2)}\n`, 'utf8');
    this.database()
      .prepare('INSERT INTO snapshots (id, project_id, label, schema_hash, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(snapId, id, label ?? null, schemaHash, createdAt);
    return {
      id: snapId,
      projectId: id,
      ...(label !== undefined ? { label } : {}),
      schemaHash,
      createdAt,
    };
  }

  /** 回滚到快照。快照存的是全量 IR，所以回滚 = 用快照内容重写全部画布 */
  async restoreSnapshot(id: string, snapshotId: string): Promise<{ schemaHash: string }> {
    const project = this.getProject(id);
    const row = this.database()
      .prepare('SELECT * FROM snapshots WHERE id = ? AND project_id = ?')
      .get(snapshotId, id) as unknown as SnapshotRow | undefined;
    if (row === undefined) throw new NotFoundError(`快照不存在：${snapshotId}`);

    const raw = await readFile(join(this.projectDir(id), SNAPSHOT_DIR, `${snapshotId}.json`), 'utf8');
    const ir = coerceToIR(JSON.parse(raw) as unknown, `snapshot:${snapshotId}`);
    ir.meta.updatedAt = new Date().toISOString();

    if (project.mode === 'file') {
      await saveIR(join(project.sourcePath!, 'ir.json'), ir);
    } else {
      const dir = this.projectDir(id);
      await writeProjectFile(dir, id, ir);
      await writeCanvasFiles(dir, ir);
    }
    this.touch(id, ir);
    return { schemaHash: computeSchemaHash(ir) };
  }

  private touch(id: string, ir: IR): void {
    this.database()
      .prepare('UPDATE projects SET name = ?, updated_at = ? WHERE id = ?')
      .run(ir.project.name, ir.meta.updatedAt, id);
  }
}

function toRecord(row: ProjectRow): ProjectRecord {
  return {
    id: row.id,
    name: row.name,
    mode: row.mode === 'file' ? 'file' : 'managed',
    ...(row.source_path !== null ? { sourcePath: row.source_path } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ────────────────────────────── 文件读写 ──────────────────────────────

function splitProjectFile(id: string, ir: IR): ProjectFile {
  return {
    schemaVersion: 1,
    id,
    name: ir.project.name,
    project: ir.project,
    dictionaries: ir.dictionaries,
    assets: ir.assets,
    settings: ir.settings,
    meta: ir.meta,
  };
}

async function writeProjectFile(dir: string, id: string, ir: IR): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'project.json'), `${JSON.stringify(splitProjectFile(id, ir), null, 2)}\n`, 'utf8');
}

async function writeOneCanvas(dir: string, ir: IR, canvasId: string): Promise<void> {
  const canvas = ir.canvases.find((c) => c.id === canvasId);
  if (canvas === undefined) throw new NotFoundError(`画布不存在：${canvasId}`);
  const doc: CanvasDoc = {
    canvas,
    nodes: ir.nodes.filter((n) => n.canvasId === canvasId),
    edges: ir.edges.filter((e) => e.canvasId === canvasId),
  };
  const target = join(dir, CANVAS_DIR, `${canvasId}.ir.json`);
  await mkdir(join(dir, CANVAS_DIR), { recursive: true });
  await writeFile(target, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
}

async function writeCanvasFiles(dir: string, ir: IR): Promise<void> {
  for (const canvas of ir.canvases) await writeOneCanvas(dir, ir, canvas.id);
}

/** 从拆分的文件还原一份完整 IR，顺序按 canvas.order，保证两次读结果一致 */
async function readManagedIR(dir: string): Promise<IR> {
  const projectRaw = await readFile(join(dir, 'project.json'), 'utf8');
  const base = JSON.parse(projectRaw) as ProjectFile;
  const canvasDir = join(dir, CANVAS_DIR);
  const files = existsSync(canvasDir) ? (await readdir(canvasDir)).filter((f) => f.endsWith('.ir.json')).sort() : [];

  const docs: CanvasDoc[] = [];
  for (const file of files) {
    docs.push(JSON.parse(await readFile(join(canvasDir, file), 'utf8')) as CanvasDoc);
  }
  docs.sort((a, b) => a.canvas.order - b.canvas.order);

  const assembled = {
    schemaVersion: 1,
    project: base.project,
    canvases: docs.map((d) => d.canvas),
    nodes: docs.flatMap((d) => d.nodes),
    edges: docs.flatMap((d) => d.edges),
    dictionaries: base.dictionaries,
    assets: base.assets,
    settings: base.settings,
    meta: base.meta,
  };
  return coerceToIR(assembled, join(dir, 'project.json'));
}

/**
 * 把一份画布文档合进 IR。
 *
 * 只替换目标画布的节点与边：其它画布的内容原样带回。这里刻意用「按 canvasId 过滤
 * 后拼接」而不是「整体替换 nodes 数组」——后者会静默删掉别的画布的数据。
 */
function applyCanvasDoc(ir: IR, canvasId: string, raw: unknown): IR {
  const doc = raw as Partial<CanvasDoc>;
  if (doc?.canvas === undefined || !Array.isArray(doc.nodes) || !Array.isArray(doc.edges)) {
    throw new ValidationError('画布文档格式不对，需要 { canvas, nodes, edges }', []);
  }
  if (doc.canvas.id !== canvasId) {
    throw new ValidationError(`路径里的画布 ID（${canvasId}）与文档里的（${doc.canvas.id}）不一致`, []);
  }

  const canvas = doc.canvas;
  const nodes = doc.nodes.map((n) => ({ ...n, canvasId }));
  const edges = doc.edges.map((e) => ({ ...e, canvasId }));

  const canvases = ir.canvases.some((c) => c.id === canvasId)
    ? ir.canvases.map((c) => (c.id === canvasId ? canvas : c))
    : [...ir.canvases, canvas];

  return {
    ...ir,
    canvases,
    nodes: [...ir.nodes.filter((n) => n.canvasId !== canvasId), ...nodes],
    edges: [...ir.edges.filter((e) => e.canvasId !== canvasId), ...edges],
  };
}
