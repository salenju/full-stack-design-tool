#!/bin/sh
# 逐包类型检查测试文件。
#
# 为什么不在根 tsconfig 里统一 include：每个包都开了 composite/declaration，
# 而测试文件不需要（也不应该）产出 .d.ts；混在一起会让 tsc -b 把测试文件
# 也算进构建产物。用 per-package tsconfig.test.json 是 TypeScript 官方推荐做法。
#
# 用 find 而不是手写列表：新加包时忘了补一行，测试文件里的类型错误就会
# 一直藏着——直到某次 Zod strip 掉了字段在运行时才暴露。
set -e
status=0
for config in $(find packages apps -maxdepth 3 -name tsconfig.test.json -not -path '*/node_modules/*' | sort); do
  dir=$(dirname "$config")
  echo "→ $dir"
  if ! npx tsc -p "$config"; then
    status=1
  fi
done
exit $status
