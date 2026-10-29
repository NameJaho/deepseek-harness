#!/usr/bin/env bash
# 纯官方 dev 分支的测试环境启动器：不加载任何公司 patch、不安装登录插件。
# 公网域名在上游终止 TLS 并到达本机 3800 端口，由 nginx 转发到 DSH_PORT。
# 没有登录插件时，凡能访问监听地址者即以 Owner 身份接入，务必只对可信网络开放。
set -euo pipefail
umask 077

DSH_REPO="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

DSH_BASE="${DSH_BASE:-$HOME/dsh-dev}"
DSH_HOST="${DSH_HOST:-127.0.0.1}"
DSH_PORT="${DSH_PORT:-3080}"
DSH_PUBLIC_URL="${DSH_PUBLIC_URL:-https://test-hmwork.busyming.com/}"
DSH_TRUSTED_HOST="${DSH_TRUSTED_HOST:-test-hmwork.busyming.com}"
DSH_PROFILE="${DSH_PROFILE:-test-web}"
DSH_PID_FILE="${DSH_PID_FILE:-$DSH_BASE/dsh.pid}"
DSH_STOP_TIMEOUT_SECONDS="${DSH_STOP_TIMEOUT_SECONDS:-90}"
# 独立的 harness home，避免继承公司 profile 的插件与会话数据。
# Use DSH_TEST_HOME when a deployment needs a stable non-default location.
DSH_INHERITED_HOME="${DSH_HOME-}"
export DSH_HOME="${DSH_TEST_HOME:-$DSH_BASE/dsh-data}"
if [[ -n "$DSH_INHERITED_HOME" && "$DSH_INHERITED_HOME" != "$DSH_HOME" ]]; then
  printf '忽略继承的 DSH_HOME=%s；测试环境使用 DSH_HOME=%s（如需指定请使用 DSH_TEST_HOME）\n' \
    "$DSH_INHERITED_HOME" "$DSH_HOME" >&2
fi

if [[ ! "$DSH_STOP_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
  printf 'DSH_STOP_TIMEOUT_SECONDS 必须是正整数\n' >&2
  exit 1
fi

if ! command -v corepack > /dev/null 2>&1; then
  printf '请安装项目要求的 Node.js 和 Corepack；启动器不需要全局 dsh 命令\n' >&2
  exit 1
fi

# 只停止本脚本 PID 文件记录的进程；其他服务占用端口时如实报错，不越权终止。
stop_previous() {
  local pid
  [[ -f "$DSH_PID_FILE" ]] || return 0
  read -r pid < "$DSH_PID_FILE" || true
  [[ "${pid:-}" =~ ^[0-9]+$ ]] || { rm -f "$DSH_PID_FILE"; return 0; }
  if ! kill -0 "$pid" 2> /dev/null; then
    rm -f "$DSH_PID_FILE"
    return 0
  fi
  local command_line
  command_line="$(ps -p "$pid" -o args= 2> /dev/null || true)"
  if [[ "$command_line" != *"$DSH_REPO"* ]]; then
    printf 'PID 文件指向的进程不属于本仓库，拒绝终止：%s\n' "$pid" >&2
    exit 1
  fi
  printf '正在停止旧服务 PID：%s\n' "$pid"
  kill "$pid" 2> /dev/null || true
  local attempt
  for (( attempt = 0; attempt < DSH_STOP_TIMEOUT_SECONDS * 2; attempt++ )); do
    kill -0 "$pid" 2> /dev/null || { rm -f "$DSH_PID_FILE"; return 0; }
    sleep 0.5
  done
  printf '旧服务未能在 %s 秒内停止，拒绝启动新服务：%s\n' "$DSH_STOP_TIMEOUT_SECONDS" "$pid" >&2
  exit 1
}

stop_previous

if command -v lsof > /dev/null 2>&1 \
  && lsof -nP -iTCP:"$DSH_PORT" -sTCP:LISTEN > /dev/null 2>&1; then
  printf '端口 %s 已被其他进程占用（可能是 master 分支的公司服务）；请先停止它或改用 DSH_PORT\n' "$DSH_PORT" >&2
  exit 1
fi

mkdir -p "$DSH_BASE"
cd "$DSH_REPO"

# Keep the test profile independent from a previously deployed company `web`
# profile. A contaminated profile is retained as a timestamped backup before
# the shipped official Web template recreates it.
DSH_PROFILE_DIR="$DSH_HOME/profiles/$DSH_PROFILE"
DSH_PROFILE_INIT=0
if [[ ! -f "$DSH_PROFILE_DIR/package.json" ]]; then
  DSH_PROFILE_INIT=1
elif ! node - "$DSH_PROFILE_DIR/package.json" <<'NODE'
const fs = require('node:fs')
const path = process.argv[2]
const manifest = JSON.parse(fs.readFileSync(path, 'utf8'))
const bundles = manifest.dsh?.profile?.bundles
const dependencies = Object.keys(manifest.dependencies ?? {})
const expected = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
const official = Array.isArray(bundles)
  && bundles.length === expected.length
  && bundles.every((name, index) => name === expected[index])
  && dependencies.length === 0
process.exit(official ? 0 : 1)
NODE
then
  DSH_PROFILE_BACKUP="$DSH_BASE/profile-backups/$DSH_PROFILE-$(date +%Y%m%d%H%M%S)"
  mkdir -p "$(dirname "$DSH_PROFILE_BACKUP")"
  mv "$DSH_PROFILE_DIR" "$DSH_PROFILE_BACKUP"
  printf '检测到非官方测试 profile，已备份到：%s\n' "$DSH_PROFILE_BACKUP" >&2
  DSH_PROFILE_INIT=1
fi

if [[ "${DSH_SKIP_INSTALL:-0}" != "1" ]]; then
  corepack pnpm install --frozen-lockfile
fi
if [[ "${DSH_SKIP_BUILD:-0}" != "1" ]]; then
  DSH_GATE_CONCURRENCY="${DSH_GATE_CONCURRENCY:-2}" corepack pnpm run build
fi

DSH_COMMAND=(corepack pnpm dsh --profile "$DSH_PROFILE")
if [[ "$DSH_PROFILE_INIT" == "1" ]]; then
  DSH_COMMAND+=(--from-default-profile web)
fi
DSH_COMMAND+=(--no-open --host "$DSH_HOST" --port "$DSH_PORT")
if [[ -n "$DSH_PUBLIC_URL" ]]; then
  DSH_COMMAND+=(--public-url "$DSH_PUBLIC_URL")
fi
if [[ -n "$DSH_TRUSTED_HOST" ]]; then
  DSH_COMMAND+=(--trusted-host "$DSH_TRUSTED_HOST")
fi
DSH_COMMAND+=("$@")

if [[ "${DSH_FOREGROUND:-0}" == "1" ]]; then
  exec "${DSH_COMMAND[@]}"
fi

nohup "${DSH_COMMAND[@]}" > "$DSH_BASE/dsh.log" 2>&1 < /dev/null &

pid="$!"
printf '%s\n' "$pid" > "$DSH_PID_FILE"
printf '启动进程 PID：%s\n' "$pid"
printf '启动日志：%s/dsh.log\n' "$DSH_BASE"
printf 'harness home：%s\n' "$DSH_HOME"
printf '服务监听地址：http://%s:%s\n' "$DSH_HOST" "$DSH_PORT"
if [[ -n "$DSH_PUBLIC_URL" ]]; then
  printf '对外访问地址：%s\n' "$DSH_PUBLIC_URL"
fi
printf '警告：本分支无登录插件，访问监听地址即获得 Owner 权限\n' >&2
