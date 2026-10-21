#!/usr/bin/env bash
# 测量 shared-core attach 架构的真实内存成本：
#   1 workspace = 1 无头 core(app-server --no-plugins) + N 个 pi-tui 瘦客户端。
# 流程：全新隔离环境 → ensureServer 拉起 core → N 个 PTY 客户端 attach →
# 稳态后报告 per-client RSS、server RSS + 子进程数、合计。
#
# 用法：N=2 SETTLE_SECONDS=15 apps/zcode-cli/scripts/measure-attach.sh
#   ZCODE            被测 zcode 入口（默认 PATH 里的 zcode）
#   N                客户端数量（默认 2）
#   SETTLE_SECONDS   attach 完成后的稳态等待（默认 15）
#   KEEP=1           结束后不清理进程与工作目录（调试）

set -u

N="${N:-2}"
SETTLE_SECONDS="${SETTLE_SECONDS:-15}"
ZCODE="${ZCODE:-zcode}"
WORK="${WORK:-$(mktemp -d /tmp/zcode-attach-measure.XXXXXX)}"
BASE="$WORK/env"
mkdir -p "$BASE/home" "$BASE/data" "$BASE/tmp" "$BASE/workspace" "$BASE/logs" "$BASE/bin"

# ensureServer 通过 PATH 里的 `zcode` 拉起 core —— 必须与被测入口同一个，
# 否则落到系统 wrapper（可能不带 --socket/--no-plugins）。
ZCODE_RESOLVED="$(command -v "$ZCODE" || true)"
if [ -z "$ZCODE_RESOLVED" ]; then
  echo "measure-attach: ZCODE '$ZCODE' not found" >&2
  exit 1
fi
printf '#!/bin/sh\nexec "%s" "$@"\n' "$ZCODE_RESOLVED" > "$BASE/bin/zcode"
chmod +x "$BASE/bin/zcode"

SCRIPT_BIN="$(command -v script || true)"
if [ -z "$SCRIPT_BIN" ]; then
  echo "measure-attach: 'script' (util-linux) not found; a PTY is required." >&2
  exit 1
fi

ENV_ARGS=(
  "HOME=$BASE/home"
  "PATH=$BASE/bin:$PATH"
  "ZCODE_DATA_BASE_DIR=$BASE/data"
  "XDG_CONFIG_HOME=$BASE/home/.config"
  "XDG_DATA_HOME=$BASE/home/.local/share"
  "XDG_CACHE_HOME=$BASE/home/.cache"
  "TMPDIR=$BASE/tmp"
  "TERM=xterm-256color"
)

# 客户端 PID = 每个 script wrapper 的子进程（zcode attach exec 为 zcode-cli）。
client_pids() {
  for sp in "${SCRIPT_PIDS[@]:-}"; do
    pgrep -P "$sp" 2>/dev/null
    for c in $(pgrep -P "$sp" 2>/dev/null); do pgrep -P "$c" 2>/dev/null; done
  done | sort -u
}

server_pid() {
  cat "$BASE"/data/.zcode/v2/sockets/*.pid 2>/dev/null | head -1
}

rss_kb() { awk '/VmRSS/{print $2}' "/proc/$1/status" 2>/dev/null; }
mb() { awk -v k="${1:-0}" 'BEGIN{printf "%.0f", k/1024}'; }

cleanup() {
  [ "${KEEP:-0}" = "1" ] && return 0
  for p in $(client_pids); do kill -TERM "$p" 2>/dev/null; done
  spid="$(server_pid)"
  [ -n "$spid" ] && kill -TERM "$spid" 2>/dev/null
  sleep 1
  for p in "${SCRIPT_PIDS[@]:-}"; do kill -TERM "$p" 2>/dev/null; done
  rm -rf "$WORK" 2>/dev/null
}
trap cleanup EXIT

echo "measure-attach: workdir=$WORK  zcode=$ZCODE  N=$N"

# --- fresh start：清掉该 workspace 可能残留的 core（只动本测量环境） ---
SPID_OLD="$(server_pid)"
[ -n "$SPID_OLD" ] && kill -TERM "$SPID_OLD" 2>/dev/null
rm -f "$BASE"/data/.zcode/v2/sockets/*.sock 2>/dev/null

# --- 启动 N 个 PTY 客户端；首个会 ensureServer 拉起 detached core ---
SCRIPT_PIDS=()
for i in $(seq 1 "$N"); do
  setsid env "${ENV_ARGS[@]}" "$SCRIPT_BIN" -qefc \
    "cd '$BASE/workspace' && '$ZCODE' attach" "$BASE/logs/client$i.log" </dev/null >/dev/null 2>&1 &
  SCRIPT_PIDS+=($!)
done

# --- 等 server socket 出现 ---
SOCK=""
for _ in $(seq 1 60); do
  SOCK="$(ls "$BASE"/data/.zcode/v2/sockets/*.sock 2>/dev/null | head -1)"
  [ -n "$SOCK" ] && break
  sleep 1
done
if [ -z "$SOCK" ]; then
  echo "measure-attach: server socket never appeared" >&2
  for f in "$BASE"/logs/client*.log; do
    echo "--- $f" >&2
    tr -d '\000' < "$f" | tail -6 >&2
  done
  exit 1
fi

# --- 等 N 个客户端连上 socket ---
CONNECTED=0
for _ in $(seq 1 60); do
  CONNECTED="$(ss -x 2>/dev/null | grep -c "$SOCK")"
  [ "$CONNECTED" -ge "$N" ] && break
  sleep 1
done
echo "measure-attach: socket=$SOCK  established=$CONNECTED/$N"
[ "$CONNECTED" -lt "$N" ] && echo "measure-attach: WARN not all clients attached" >&2

sleep "$SETTLE_SECONDS"

# --- 采样 ---
# detached core 在首个客户端退出前仍挂在该客户端的进程树下 —— 从客户端列表剔除 server pid。
SPID="$(server_pid)"
declare -a CLIENTS
while read -r p; do
  [ -n "$p" ] && [ "$p" != "$SPID" ] && CLIENTS+=("$p")
done < <(client_pids)

TOTAL_KB=0
echo
printf "%-14s %-8s %-8s %s\n" "process" "pid" "RSS(MB)" "children"
printf "%-14s %-8s %-8s %s\n" "--------------" "--------" "--------" "--------"
i=0
for p in "${CLIENTS[@]:-}"; do
  i=$((i+1))
  rss="$(rss_kb "$p")"; kids="$(ps --ppid "$p" -o pid= 2>/dev/null | wc -l | tr -d ' ')"
  printf "%-14s %-8s %-8s %s\n" "client-$i" "$p" "$(mb "$rss")" "$kids"
  TOTAL_KB=$((TOTAL_KB + ${rss:-0}))
done
if [ -n "$SPID" ]; then
  rss="$(rss_kb "$SPID")"; kids="$(ps --ppid "$SPID" -o pid= 2>/dev/null | wc -l | tr -d ' ')"
  printf "%-14s %-8s %-8s %s\n" "server" "$SPID" "$(mb "$rss")" "$kids"
  TOTAL_KB=$((TOTAL_KB + ${rss:-0}))
else
  echo "server           <gone>"
fi
printf "%-14s %-8s %-8s %s\n" "--------------" "--------" "--------" "--------"
printf "%-14s %-8s %-8s\n" "TOTAL" "" "$(mb "$TOTAL_KB")"
echo
echo "acceptance: client < 200MB, server < 1229MB (1.2GB), N=2 total < 1638MB (1.6GB)"
