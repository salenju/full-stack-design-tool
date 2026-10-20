import { fileURLToPath, URL } from 'node:url';

import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';

import { fsdtApi } from './server/plugin.js';

/**
 * 把 `node:crypto` / `node:fs/promises` / `node:path` 换成浏览器可加载的空壳。
 *
 * `@fsdt/core-ir` 一边给 CLI 用（Node），一边被工作台 import（浏览器）。
 * - hash.ts 静态 import `node:crypto`：ESM 静态链接会让 hash.js 一被加载就求值，
 *   于是整个前端在 import 阶段就炸。
 * - io.ts 已经改成动态 import `node:fs/promises` / `node:path`，加载期没事，
 *   但 vite 仍会把它们 externalize 并打两条警告，噪音容易掩盖真正的问题。
 *
 * 这里统一给「能加载、一调用就报错」的实现：浏览器端从不调这些函数
 * （哈希由服务端算，IO 走 dev 中间件），真被误用时会立刻炸在调用点而不是静默出错。
 */
function nodeBuiltinStub(): Plugin {
  const TAGS = {
    crypto: '\0fsdt-node-stub:crypto',
    fs: '\0fsdt-node-stub:fs',
    path: '\0fsdt-node-stub:path',
  } as const;

  return {
    name: 'fsdt-node-stub',
    enforce: 'pre',
    resolveId(source) {
      if (source === 'node:crypto') return TAGS.crypto;
      if (source === 'node:fs/promises') return TAGS.fs;
      if (source === 'node:path') return TAGS.path;
      return null;
    },
    load(id) {
      if (id === TAGS.crypto) {
        return `
const unavailable = (name) => () => {
  throw new Error('[fsdt] node:crypto.' + name + ' 在浏览器端不可用：哈希请由服务端算。');
};
export function createHash() {
  return { update() { return this; }, digest: unavailable('digest') };
}
export const randomUUID = () =>
  globalThis.crypto?.randomUUID?.() ?? '00000000-0000-4000-8000-000000000000';
export default { createHash, randomUUID };
`;
      }
      if (id === TAGS.fs) {
        const names = ['readFile', 'writeFile', 'mkdir', 'copyFile', 'access', 'rename', 'unlink', 'rm', 'stat'];
        return `${names
          .map(
            (name) =>
              `export const ${name} = () => { throw new Error('[fsdt] node:fs/promises.${name} 在浏览器端不可用：IR 读写走 dev 中间件。'); };`,
          )
          .join('\n')}
export default {};
`;
      }
      if (id === TAGS.path) {
        return `
const unavailable = () => {
  throw new Error('[fsdt] node:path 在浏览器端不可用：路径处理应该在 dev 中间件里做。');
};
export const resolve = unavailable;
export const dirname = unavailable;
export const join = unavailable;
export default {};
`;
      }
      return null;
    },
  };
}

export default defineConfig({
  plugins: [nodeBuiltinStub(), vue(), fsdtApi()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5180,
    strictPort: false,
    open: false,
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    // Element Plus 全量引入把主包顶到 1.3MB（gzip 420KB）。这是内部工具，
    // 首屏在 localhost 上无感，不值得为它上按需加载的复杂度。
    chunkSizeWarningLimit: 1600,
  },
});
