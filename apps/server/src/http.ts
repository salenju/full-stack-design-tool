/**
 * HTTP 层：路由表、请求解析、CORS、SSE、错误映射。
 *
 * 刻意不引框架：这个服务只在本机跑、端点只有十几个，express 带来的依赖树
 * 换不来任何东西。而「零依赖」在这里有个额外好处——`fsdt serve` 可以当成
 * 一个单文件脚本拷走就能跑。
 *
 * 绑定地址默认 127.0.0.1：服务能改项目文件、能生成代码，等于给了本机写权限，
 * 绝不能默认监听 0.0.0.0。要对外暴露请自己用 `--host` 并想清楚鉴权。
 */

import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  createProject,
  deleteProject,
  download,
  getIr,
  getJob,
  getProject,
  health,
  jobEvents,
  listProjects,
  listSnapshots,
  postCompile,
  postGenerate,
  postGeneratePreview,
  postLint,
  postLintFix,
  createSnapshot,
  putCanvas,
  restoreSnapshot,
  toHttpError,
  type HandlerDeps,
} from './handlers.js';
import { JobRegistry } from './jobs.js';
import { Router, type HttpResponse, type RequestContext } from './router.js';
import { ProjectStore } from './store.js';

export interface ServerOptions {
  /** 服务模式的根目录，默认 ~/.fsdt */
  home: string;
  /** 额外的允许跨域来源 */
  allowOrigin?: string[];
  /** 请求体上限，默认 64MB（IR 可能很大） */
  maxBodyBytes?: number;
  /** 监听地址，默认 127.0.0.1 */
  host?: string;
  port?: number;
}

export interface RunningServer {
  server: Server;
  port: number;
  url: string;
  store: ProjectStore;
  jobs: JobRegistry;
  close(): Promise<void>;
}

const DEFAULT_MAX_BODY = 64 * 1024 * 1024;

export function buildRouter(deps: HandlerDeps): Router {
  const router = new Router();
  router
    .get('/api/health', () => health(deps))
    .get('/api/projects', () => listProjects(deps))
    .post('/api/projects', (ctx) => createProject(deps, ctx))
    .get('/api/projects/:id', (ctx) => getProject(deps, ctx))
    .delete('/api/projects/:id', (ctx) => deleteProject(deps, ctx))
    .get('/api/projects/:id/ir', (ctx) => getIr(deps, ctx))
    .put('/api/projects/:id/canvases/:canvasId', (ctx) => putCanvas(deps, ctx))
    .post('/api/projects/:id/lint', (ctx) => postLint(deps, ctx))
    .post('/api/projects/:id/lint/fix', (ctx) => postLintFix(deps, ctx))
    .post('/api/projects/:id/compile', (ctx) => postCompile(deps, ctx))
    .post('/api/projects/:id/generate/preview', (ctx) => postGeneratePreview(deps, ctx))
    .post('/api/projects/:id/generate', (ctx) => postGenerate(deps, ctx))
    .get('/api/projects/:id/snapshots', (ctx) => listSnapshots(deps, ctx))
    .post('/api/projects/:id/snapshots', (ctx) => createSnapshot(deps, ctx))
    .post('/api/projects/:id/snapshots/:sid/restore', (ctx) => restoreSnapshot(deps, ctx))
    .get('/api/projects/:id/download', (ctx) => download(deps, ctx))
    .get('/api/jobs/:jobId', (ctx) => getJob(deps, ctx))
    .get('/api/jobs/:jobId/events', (ctx) => jobEvents(deps, ctx));
  return router;
}

function originAllowed(origin: string, extra: string[]): boolean {
  if (extra.includes(origin)) return true;
  // 只放行本机来源：工作台 dev server 默认 5180，但端口会变，所以按 host 放行
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin);
}

function applyCors(req: IncomingMessage, res: ServerResponse, extra: string[]): void {
  const origin = req.headers.origin;
  if (typeof origin !== 'string') return;
  if (!originAllowed(origin, extra)) return;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, If-Match');
  res.setHeader('Access-Control-Expose-Headers', 'ETag');
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limit) throw new Error(`请求体超过上限（${Math.round(limit / 1024 / 1024)}MB）`);
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function parseBody(raw: Buffer, contentType: string | undefined): unknown {
  if (raw.length === 0) return undefined;
  if (contentType !== undefined && contentType.includes('application/json')) {
    try {
      return JSON.parse(raw.toString('utf8')) as unknown;
    } catch {
      throw new Error('请求体不是合法 JSON');
    }
  }
  return undefined;
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(text);
}

function writeSse(res: ServerResponse, response: Extract<HttpResponse, { kind: 'sse' }>): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  let closed = false;
  const send = (event: string, data: unknown): void => {
    if (closed) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const close = (): void => {
    if (closed) return;
    closed = true;
    res.end();
  };
  // 心跳：中间代理常在 30s 空闲后掐连接，没有心跳 SSE 会莫名其妙断掉
  const heartbeat = setInterval(() => {
    if (!closed) res.write(': ping\n\n');
  }, 15_000);
  const cleanup = response.run(send, close);
  res.on('close', () => {
    clearInterval(heartbeat);
    cleanup();
  });
}

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const store = new ProjectStore(options.home);
  await store.init();
  const jobs = new JobRegistry();
  const deps: HandlerDeps = { store, jobs };
  const router = buildRouter(deps);
  const limit = options.maxBodyBytes ?? DEFAULT_MAX_BODY;
  const allowOrigin = options.allowOrigin ?? [];

  const server = createHttpServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      const mapped = toHttpError(error);
      if (mapped !== undefined) {
        writeJson(res, mapped.status, mapped.body);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      writeJson(res, 500, { error: message });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    applyCors(req, res, allowOrigin);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = decodeURIComponent(url.pathname);
    const method = (req.method ?? 'GET').toUpperCase();

    const hit = router.match(method, path);
    if (hit === undefined) {
      const others = router.methodsOf(path);
      if (others.length > 0) {
        res.setHeader('Allow', [...new Set(others)].join(', '));
        writeJson(res, 405, { error: `方法不被支持：${method} ${path}` });
        return;
      }
      writeJson(res, 404, { error: `没有这个端点：${path}` });
      return;
    }

    const raw = method === 'GET' || method === 'DELETE' ? Buffer.alloc(0) : await readBody(req, limit);
    const contentType = req.headers['content-type'];
    const ctx: RequestContext = {
      method,
      path,
      params: hit.params,
      query: url.searchParams,
      headers: req.headers,
      body: parseBody(raw, contentType),
      raw,
    };

    const response = await hit.handler(ctx);
    switch (response.kind) {
      case 'json': {
        if (response.headers !== undefined) {
          for (const [key, value] of Object.entries(response.headers)) res.setHeader(key, value);
        }
        writeJson(res, response.status, response.body);
        return;
      }
      case 'text':
        res.writeHead(response.status, { 'Content-Type': response.contentType ?? 'text/plain; charset=utf-8' });
        res.end(response.body);
        return;
      case 'binary': {
        const headers: Record<string, string> = {
          'Content-Type': response.contentType,
          'Content-Length': String(response.body.length),
        };
        if (response.fileName !== undefined) {
          const ascii = response.fileName.replace(/[^\x20-\x7e]/g, '_');
          headers['Content-Disposition'] = `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(response.fileName)}`;
        }
        res.writeHead(response.status, headers);
        res.end(response.body);
        return;
      }
      case 'sse':
        writeSse(res, response);
        return;
      default:
        res.writeHead(204);
        res.end();
    }
  }

  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 4590;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  return {
    server,
    port: address.port,
    url: `http://${host}:${address.port}`,
    store,
    jobs,
    close: async () => {
      store.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
