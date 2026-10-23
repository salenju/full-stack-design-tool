#!/bin/sh
# 端到端冒烟：从空目录跑完所有 CLI 命令，确认产物自洽。
#
# 为什么要有它：单测覆盖的是每个包的行为，但「CLI 装起来能不能真的跑通
# 一条链路」是另一回事——路径解析、退出码、--check 与 --out 的互斥，
# 都只有真跑一次才看得见。CI 里跑这个，能拦住「包各自绿、串起来崩」。
set -eu

REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
CLI="node $REPO_ROOT/apps/cli/dist/main.js"

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT INT TERM
cd "$WORK"

fail() { echo "✗ $1" >&2; exit 1; }
ok()   { echo "✓ $1"; }

# ── 1. init ──────────────────────────────────────────────────────────
$CLI init --name 冒烟项目 >/dev/null 2>&1 || fail "init 失败"
[ -f design/ir.json ] || fail "init 没有产出 design/ir.json"
ok "init"

# ── 2. 塞一个有内容的 IR（空 IR 编译不出东西，验不出真问题）─────────
node --input-type=module -e "
import { buildFixture } from '$REPO_ROOT/packages/core-ir/dist/testing/fixtures.js';
import { saveIR } from '$REPO_ROOT/packages/core-ir/dist/index.js';
const { ir } = buildFixture();
await saveIR('design/ir.json', ir);
"
ok "fixture IR"

# ── 3. lint ──────────────────────────────────────────────────────────
$CLI lint >/dev/null 2>&1 || fail "lint 报了 error"
ok "lint"

# ── 4. compile：同 IR 两次输出必须字节一致 ───────────────────────────
$CLI compile --stdout json > a.json 2>/dev/null
$CLI compile --stdout json > b.json 2>/dev/null
cmp -s a.json b.json || fail "compile --stdout 两次输出不一致（确定性被破坏）"
node -e "
const b = JSON.parse(require('fs').readFileSync('a.json', 'utf8'));
if (!b.openapi?.document?.paths) throw new Error('缺 openapi');
if (!Array.isArray(b.uiSchema?.pages) || b.uiSchema.pages.length === 0) throw new Error('缺页面');
if (!Array.isArray(b.samples?.tables)) throw new Error('缺示例数据');
" || fail "compile 产物结构不完整"
ok "compile（确定性 + 结构）"

# ── 5. gen --out：真写盘 ─────────────────────────────────────────────
$CLI gen --out ./output >/dev/null 2>&1 || fail "gen --out 失败"
[ -f output/frontend/src/main.ts ] || fail "缺前端入口"
[ -f output/backend/src/main.ts ] || fail "缺后端入口"
[ -f output/backend/prisma.config.ts ] || fail "Prisma 7 需要 prisma.config.ts"
grep -q 'url *=' output/backend/prisma/schema.prisma && fail "Prisma 7 的 schema 里不能再有 url"
ok "gen --out"

# ── 6. gen --check：一致时 0 ─────────────────────────────────────────
$CLI gen --check >/dev/null 2>&1 || fail "刚生成完 --check 就该通过"
ok "gen --check（一致）"

# ── 7. gen --check：手改后必须非 0 ───────────────────────────────────
echo '<template><div>手改</div></template>' > output/frontend/src/views/devices.vue
if $CLI gen --check >/dev/null 2>&1; then fail "手改后 --check 没报漂移"; fi
ok "gen --check（检测漂移）"
$CLI gen --out ./output --force >/dev/null 2>&1 || fail "恢复失败"
$CLI gen --check >/dev/null 2>&1 || fail "恢复后 --check 应通过"
ok "gen --check（恢复）"

# ── 8. gen 幂等：再跑一次应全是未变 ─────────────────────────────────
OUT=$($CLI gen --out ./output 2>&1)
# 断言「新增/更新 0」而不是某个具体文件数：文件数会随生成器演进变化，
# 把它写进冒烟等于每次加文件都得改脚本，很快就会被改成 `|| true`
echo "$OUT" | grep -q '新增/更新 0，未变 [1-9]' || fail "gen 不幂等：$OUT"
ok "gen（幂等）"

# ── 9. 往返：往 todo 区块里写实现，重新生成不丢 ──────────────────────
# 这一步守的是产品的命门：用户改过生成代码后还敢不敢再跑一次 gen。
SVC=output/backend/src/modules/devices/devices.service.ts
if [ -f "$SVC" ]; then
  grep -q '@dsg:todo start name=listDevices' "$SVC" || fail "service 没有 @dsg:todo 区块，往返机制退化"
  node -e "
const fs = require('fs');
const p = 'output/backend/src/modules/devices/devices.service.ts';
const t = fs.readFileSync(p, 'utf8');
fs.writeFileSync(p, t.replace('throw new NotImplementedException(\'listDevices\');', 'return mine;'));
" || fail "注入实现失败"
  $CLI gen --out ./output >/dev/null 2>&1 || fail "实现 todo 区块后 gen 失败（应该合并而不是报错）"
  grep -q 'return mine;' "$SVC" || fail "重新生成把手写实现冲掉了"
  $CLI gen --check >/dev/null 2>&1 || fail "实现 todo 区块后 --check 报漂移（手写不该算漂移）"
  $CLI gen --out ./output --force >/dev/null 2>&1 || fail "恢复失败"
  ok "往返（实现 todo 区块后仍可重新生成）"
fi

# ── 10. sample / export ─────────────────────────────────────────────
$CLI sample --rows 3 --out ./mocks >/dev/null 2>&1 || fail "sample 失败"
[ -f mocks/devices.json ] || fail "sample 没产出 devices.json"
$CLI export --format svg,mermaid,drawio,json --out ./docs >/dev/null 2>&1 || fail "export 失败"
[ -f "docs/画布-1.svg" ] || fail "export 没产出一画布的 svg"
ok "sample / export"

# ── 11. --check 与 --out 必须互斥（否则 CI 永远绿）───────────────────
if $CLI gen --check --out ./output >/dev/null 2>&1; then
  fail "--check 与 --out 同时给却没报错"
fi
ok "--check 与 --out 互斥"

# ── 12. 二进制不能往终端吐 ──────────────────────────────────────────
if $CLI export --format png >/dev/null 2>&1; then
  fail "png 没有 --out 却没报错"
fi
ok "png 缺 --out 被拒"

echo "冒烟通过。"
