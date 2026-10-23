/**
 * 极简路由。
 *
 * 服务模式只有十几个端点，为此引入 express/koa 会让「本地起一个进程」变成
 * 「装一棵依赖树」。这里只需要：方法 + 路径模板（`:param`）+ 顺序匹配。
 *
 * 匹配规则刻意严格的另一面：**不做尾斜杠容错**。`/api/projects/` 与
 * `/api/projects` 是两个路径，前者 404。宁可让调用方一次就写对，也不要
 * 让「有的端点容错、有的不容错」这种不一致存在。
 */

import type { IncomingHttpHeaders } from 'node:http';

export interface RequestContext {
  method: string;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  /** 已解析的 JSON body（无 body 或非 JSON 时为 undefined） */
  body: unknown;
  /** 原始 body 字节（导入图片等二进制用） */
  raw: Buffer;
}

export type HttpResponse =
  | { kind: 'json'; status: number; body: unknown; headers?: Record<string, string> }
  | { kind: 'text'; status: number; body: string; contentType?: string }
  | { kind: 'binary'; status: number; body: Buffer; contentType: string; fileName?: string }
  | {
      kind: 'sse';
      /** 连接建立后调用；返回一个清理函数，客户端断开时执行 */
      run: (send: (event: string, data: unknown) => void, close: () => void) => () => void;
    };

/** handler 可以同步返回：大多数端点不需要 await，写成 async 只会多一层 Promise */
export type RouteHandler = (ctx: RequestContext) => HttpResponse | Promise<HttpResponse>;

interface Route {
  method: string;
  segments: string[];
  handler: RouteHandler;
}

export class Router {
  private readonly routes: Route[] = [];

  add(method: string, pattern: string, handler: RouteHandler): this {
    this.routes.push({ method, segments: pattern.split('/').filter((s) => s.length > 0), handler });
    return this;
  }

  get(pattern: string, handler: RouteHandler): this {
    return this.add('GET', pattern, handler);
  }

  post(pattern: string, handler: RouteHandler): this {
    return this.add('POST', pattern, handler);
  }

  put(pattern: string, handler: RouteHandler): this {
    return this.add('PUT', pattern, handler);
  }

  delete(pattern: string, handler: RouteHandler): this {
    return this.add('DELETE', pattern, handler);
  }

  /** 返回命中的 handler 与参数；未命中返回 undefined */
  match(method: string, path: string): { handler: RouteHandler; params: Record<string, string> } | undefined {
    const parts = path.split('/').filter((s) => s.length > 0);
    for (const route of this.routes) {
      if (route.method !== method) continue;
      if (route.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < route.segments.length; i += 1) {
        const seg = route.segments[i]!;
        const value = parts[i]!;
        if (seg.startsWith(':')) {
          params[seg.slice(1)] = decodeURIComponent(value);
          continue;
        }
        if (seg !== value) {
          ok = false;
          break;
        }
      }
      if (ok) return { handler: route.handler, params };
    }
    return undefined;
  }

  /** 该路径是否存在其它方法（用于 405 而不是 404） */
  methodsOf(path: string): string[] {
    const parts = path.split('/').filter((s) => s.length > 0);
    const out: string[] = [];
    for (const route of this.routes) {
      if (route.segments.length !== parts.length) continue;
      const hit = route.segments.every((seg, i) => seg.startsWith(':') || seg === parts[i]);
      if (hit) out.push(route.method);
    }
    return out;
  }
}
