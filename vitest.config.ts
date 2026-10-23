import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/**/src/**/*.test.ts',
      'packages/**/test/**/*.test.ts',
      'apps/**/src/**/*.test.ts',
      'apps/**/test/**/*.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**', '**/fixtures/**'],
    environment: 'node',
    // 默认 5s 对这批测试太紧：`gen` 的端到端用例要真渲染 30 多个文件、还要跑一遍
    // Lint 门禁，并发跑满 25 个 worker 时单条就能到 4–6s，于是「代码没坏、CI 红了」。
    // 真正的慢测试（真跑 tsc 编译产物）自己另有更长的超时。
    testTimeout: 20_000,
    hookTimeout: 20_000,
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts', 'packages/*/*/src/**/*.ts', 'apps/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/index.ts'],
    },
  },
});
