/**
 * 把 fsdt 的库能力挂到 vite dev server 上。
 *
 * 之所以做在 vite 插件里而不是独立进程：工作台和 CLI 必须操作同一份
 * `design/ir.json`，多一个进程就多一份「谁先写的」的竞态。
 * 用中间件意味着 `pnpm dev` 一条命令同时起界面和写盘通道。
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Plugin, ViteDevServer } from 'vite';

import * as h from './handlers.js';
import { ApiError } from './handlers.js';
import { ensureWorkspace, type WorkspaceInfo } from './workspace.js';

const HERE = dirname(fileURLToPath(import.meta.url));
/** apps/web/server → 仓库根 */
export const REPO_ROOT = resolve(HERE, '..', '..', '..');

type Handler = (ctx: h.ApiContext, body: unknown) => Promise<unknown>;

interface Route {
  method: 'GET' | 'PUT' | 'POST';
  path: string;
  handler: Handler;
}

const ROUTES: Route[] = [
  { method: 'GET', path: '/api/state', handler: (ctx) => h.getState(ctx) },
  { method: 'PUT', path: '/api/ir', handler: (ctx, body) => h.putIR(ctx, body) },
  { method: 'POST', path: '/api/lint', handler: (ctx, body) => h.postLint(ctx, body) },
  { method: 'POST', path: '/api/compile', handler: (ctx, body) => h.postCompile(ctx, body) },
  { method: 'POST', path: '/api/gen', handler: (ctx, body) => h.postGen(ctx, body) },
  { method: 'POST', path: '/api/export', handler: (ctx, body) => h.postExport(ctx, body) },
];

function readBody(req: import('node:http').IncomingMessage): Promise<unknown> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      // 一个 IR 顶天几百 KB；超过 8MB 一定是调用方搞错了，直接拒绝而不是把内存吃满
      if (size > 8 * 1024 * 1024) {
        reject(new ApiError('请求体超过 8MB', 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.trim().length === 0) return resolvePromise({});
      try {
        resolvePromise(JSON.parse(text) as unknown);
      } catch {
        reject(new ApiError('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function send(res: import('node:http').ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(text);
}

export function fsdtApi(): Plugin {
  let workspace: WorkspaceInfo | null = null;

  async function attach(server: ViteDevServer): Promise<void> {
    const ws = await ensureWorkspace(REPO_ROOT);
    workspace = ws;
    server.config.logger.info(
      `\n  fsdt 工作台：${ws.mode === 'file' ? '文件模式' : '工作台目录'} → ${ws.irPath}\n`,
    );
  }

  return {
    name: 'fsdt-api',
    apply: 'serve',
    async configureServer(server) {
      await attach(server).catch((err: unknown) => {
        server.config.logger.error(`[fsdt] 初始化工作区失败：${String(err)}`);
      });

      server.middlewares.use((req, res, next) => {
        const url = req.url ?? '';
        if (!url.startsWith('/api/')) {
          next();
          return;
        }
        const path = url.split('?')[0] ?? url;
        const route = ROUTES.find((r) => r.path === path && r.method === req.method);
        if (route === undefined) {
          send(res, 404, { error: `没有这个接口：${req.method ?? ''} ${path}` });
          return;
        }
        void (async () => {
          try {
            const ws = workspace ?? (await ensureWorkspace(REPO_ROOT));
            workspace = ws;
            const body = route.method === 'GET' ? {} : await readBody(req);
            const result = await route.handler({ repoRoot: REPO_ROOT, workspace: ws }, body);
            send(res, 200, result);
          } catch (err) {
            const status = err instanceof ApiError ? err.status : 500;
            const message = err instanceof Error ? err.message : String(err);
            if (status >= 500) server.config.logger.error(`[fsdt] ${path} 失败：${message}`);
            send(res, status, { error: message });
          }
        })();
      });
    },
  };
}
