#!/bin/sh
# 本地预览「生成出来的前端」。
#
# 这个仓库本身没有 Web 页面（画布编辑器 apps/web 尚未实现），
# 能在浏览器里看的东西是 fsdt gen 的产物 —— 一个完整的 Vue 3 + Element Plus 工程。
# 这个脚本把它从 IR 生成出来、装依赖、配一个提供数据的 mock 后端，然后起 vite。
#
#   ./scripts/demo.sh            生成 + 启动
#   ./scripts/demo.sh --regen    强制重新生成（清掉旧产物）
#   ./scripts/demo.sh --stop     停掉 mock 与 vite
#
# 需要先 pnpm install + pnpm build（脚本会自己检查）。

set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
WORK="$ROOT/.fsdt/demo"
OUT="$WORK/output"
FE="$OUT/frontend"
CLI="$ROOT/apps/cli/dist/main.js"
PIDFILE="$WORK/pids"

stop_all() {
  if [ -f "$PIDFILE" ]; then
    while read -r pid; do
      [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
    done < "$PIDFILE"
    rm -f "$PIDFILE"
    echo "已停止 mock 与 vite"
  else
    echo "没有正在运行的 demo 进程"
  fi
}

if [ "${1:-}" = "--stop" ]; then
  stop_all
  exit 0
fi

if [ "${1:-}" = "--regen" ]; then
  rm -rf "$OUT"
fi

# 1. CLI 要能跑
if [ ! -f "$CLI" ]; then
  echo "→ 首次运行，先构建（pnpm build）"
  ( cd "$ROOT" && pnpm install --frozen-lockfile 2>/dev/null || pnpm install )
  ( cd "$ROOT" && pnpm build )
fi

# 2. 准备 IR
mkdir -p "$WORK/design"
cp "$ROOT/scripts/demo/ir.json" "$WORK/design/ir.json"

# 3. 生成
if [ ! -d "$FE" ]; then
  echo "→ 生成前后端产物"
  ( cd "$WORK" && node "$CLI" gen --out ./output --force )
fi

# 4. 装依赖
if [ ! -d "$FE/node_modules" ]; then
  echo "→ 安装前端依赖（首次约 1-2 分钟）"
  ( cd "$FE" && pnpm install --ignore-workspace 2>/dev/null ) \
    || ( cd "$FE" && npm install --no-audit --no-fund )
fi

# 5. 起服务
: > "$PIDFILE"
echo "→ 启动 mock 后端 http://localhost:3000"
( cd "$ROOT" && node scripts/demo/mock-server.mjs > "$WORK/mock.log" 2>&1 & echo $! >> "$PIDFILE" )

echo "→ 启动 vite"
( cd "$FE" && npm run dev > "$WORK/vite.log" 2>&1 & echo $! >> "$PIDFILE" )

# 等 vite 就绪
i=0
while [ $i -lt 60 ]; do
  if curl -sf http://localhost:5173/ >/dev/null 2>&1; then
    break
  fi
  i=$((i + 1))
  sleep 1
done

echo
echo "  设备列表  http://localhost:5173/devices"
echo "  新建设备  http://localhost:5173/devices/create"
echo
echo "  日志：$WORK/mock.log / $WORK/vite.log"
echo "  停止：./scripts/demo.sh --stop"
