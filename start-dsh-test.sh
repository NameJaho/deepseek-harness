#!/usr/bin/env bash
# 企业微信自建应用测试环境：强制登录，不接受公网 Owner 启动凭据。
# 公网域名在上游终止 TLS，由反向代理保留 Host 并转发到 DSH_PORT。
# 应用 Secret 仅从服务端环境读取，不写入 patch、profile 或日志。
# DSH_* 变量不能写进仓库 .env（dsh 会拒绝启动）；改为 export，或写入 DSH_LAUNCH_ENV
# 指向的文件（默认 $DSH_BASE/launch.env，权限 600），该文件中的值覆盖当前 shell。
set -euo pipefail
# 不设置全局 umask：安装与构建产物在仓库内，须保持仓库属主的默认权限；
# 数据目录与服务进程在下方单独收紧。

DSH_REPO="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# 以其他用户（尤其 root）运行会在仓库里留下该用户的文件，导致属主后续 EACCES。
DSH_RUN_USER="$(id -un)"
foreign_path="$(find "$DSH_REPO" ! -user "$DSH_RUN_USER" -print -quit 2> /dev/null || true)"
if [[ -n "$foreign_path" ]]; then
  printf '仓库中存在不属于当前用户 %s 的文件：%s\n请以仓库属主运行，或先以 root 执行：chown -R <属主>:<属主> %s\n' \
    "$DSH_RUN_USER" "$foreign_path" "$DSH_REPO" >&2
  exit 1
fi

DSH_BASE="${DSH_BASE:-$HOME/dsh-dev}"
DSH_LAUNCH_ENV="${DSH_LAUNCH_ENV:-$DSH_BASE/launch.env}"
if [[ -f "$DSH_LAUNCH_ENV" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "$DSH_LAUNCH_ENV"
  set +a
fi
DSH_HOST="${DSH_HOST:-127.0.0.1}"
DSH_PORT="${DSH_PORT:-3080}"
DSH_PUBLIC_URL="${DSH_PUBLIC_URL:-https://test-hmwork.busyming.com/}"
DSH_TRUSTED_HOST="${DSH_TRUSTED_HOST:-test-hmwork.busyming.com}"
DSH_PROFILE="${DSH_PROFILE:-test-web}"
export DSH_PUBLIC_URL
export DSH_WECOM_CORP_ID="${DSH_WECOM_CORP_ID:-ww2ec793812513c257}"
export DSH_WECOM_AGENT_ID="${DSH_WECOM_AGENT_ID:-1000239}"
if [[ -z "${DSH_WECOM_APP_SECRET:-}" ]]; then
  printf '请先在服务端环境设置 DSH_WECOM_APP_SECRET（使用轮换后的自建应用 Secret）；拒绝无登录启动\n' >&2
  exit 1
fi
export DSH_WECOM_APP_SECRET
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

DSH_START_TIMEOUT_SECONDS="${DSH_START_TIMEOUT_SECONDS:-120}"
for timeout_name in DSH_STOP_TIMEOUT_SECONDS DSH_START_TIMEOUT_SECONDS; do
  if [[ ! "${!timeout_name}" =~ ^[1-9][0-9]*$ ]]; then
    printf '%s 必须是正整数\n' "$timeout_name" >&2
    exit 1
  fi
done

# dsh 拒绝 .env 中的 DSH_* 变量；在耗时的安装和构建之前报告，只列变量名不打印值。
for env_file in "$DSH_REPO/.env" "$DSH_HOME/.env"; do
  [[ -f "$env_file" ]] || continue
  rejected="$(grep -oE '^[[:space:]]*(export[[:space:]]+)?DSH_[A-Za-z0-9_]*' "$env_file" \
    | sed -E 's/^[[:space:]]*(export[[:space:]]+)?//' | sort -u | tr '\n' ' ' || true)"
  if [[ -n "$rejected" ]]; then
    printf '%s 中设置了 dsh 不允许的变量：%s\n请从该文件删除它们，改为 export 或写入 %s\n' \
      "$env_file" "$rejected" "$DSH_LAUNCH_ENV" >&2
    exit 1
  fi
done

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

port_in_use() {
  if command -v ss > /dev/null 2>&1; then
    ss -Hltn "sport = :$DSH_PORT" 2> /dev/null | grep -q .
  elif command -v lsof > /dev/null 2>&1; then
    lsof -nP -iTCP:"$DSH_PORT" -sTCP:LISTEN > /dev/null 2>&1
  else
    printf '未找到 ss 或 lsof，无法检查端口 %s 是否被占用\n' "$DSH_PORT" >&2
    exit 1
  fi
}

if port_in_use; then
  printf '端口 %s 已被其他进程占用（可能是 master 分支的公司服务）；请先停止它或改用 DSH_PORT\n' "$DSH_PORT" >&2
  exit 1
fi

[[ -d "$DSH_BASE" ]] || mkdir -p -m 700 "$DSH_BASE"
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
  mkdir -p -m 700 "$(dirname "$DSH_PROFILE_BACKUP")"
  mv "$DSH_PROFILE_DIR" "$DSH_PROFILE_BACKUP"
  printf '检测到非官方测试 profile，已备份到：%s\n' "$DSH_PROFILE_BACKUP" >&2
  DSH_PROFILE_INIT=1
fi

if [[ "${DSH_SKIP_INSTALL:-0}" != "1" ]]; then
  corepack pnpm install --frozen-lockfile
fi
# 完整 build 会并行运行类型检查，Host tsc 单进程可占 8GB，曾耗尽测试服务器内存；
# 运行服务只需要产物，因此串行构建产物并降低优先级。
if [[ "${DSH_SKIP_BUILD:-0}" != "1" ]]; then
  DSH_GATE_CONCURRENCY="${DSH_GATE_CONCURRENCY:-1}" \
    nice -n "${DSH_BUILD_NICE:-19}" corepack pnpm run build:artifacts --serial
fi

DSH_COMMAND=(corepack pnpm dsh --profile "$DSH_PROFILE")
if [[ "$DSH_PROFILE_INIT" == "1" ]]; then
  DSH_COMMAND+=(--from-default-profile web)
fi
# Profile overlays are outer CLI options and must precede runtime arguments.
DSH_COMMAND+=(--patch "$DSH_REPO/packages/company/wecom-auth/cordis.patch.yml")
DSH_COMMAND+=(--no-open --host "$DSH_HOST" --port "$DSH_PORT")
if [[ -n "$DSH_PUBLIC_URL" ]]; then
  DSH_COMMAND+=(--public-url "$DSH_PUBLIC_URL")
fi
if [[ -n "$DSH_TRUSTED_HOST" ]]; then
  DSH_COMMAND+=(--trusted-host "$DSH_TRUSTED_HOST")
fi
DSH_COMMAND+=("$@")

# 服务写入的会话、凭据、日志和 PID 文件仅属主可读。
umask 077

if [[ "${DSH_FOREGROUND:-0}" == "1" ]]; then
  exec "${DSH_COMMAND[@]}"
fi

nohup "${DSH_COMMAND[@]}" > "$DSH_BASE/dsh.log" 2>&1 < /dev/null &

pid="$!"
printf '%s\n' "$pid" > "$DSH_PID_FILE"
printf '启动进程 PID：%s\n' "$pid"
printf '启动日志：%s/dsh.log\n' "$DSH_BASE"

probe_host="$DSH_HOST"
[[ "$probe_host" == *:* ]] && probe_host="[$probe_host]"
started=0
for (( attempt = 0; attempt < DSH_START_TIMEOUT_SECONDS; attempt++ )); do
  if ! kill -0 "$pid" 2> /dev/null; then
    rm -f "$DSH_PID_FILE"
    printf '服务启动失败，日志末尾：\n' >&2
    tail -n 40 "$DSH_BASE/dsh.log" >&2
    exit 1
  fi
  if command -v curl > /dev/null 2>&1 \
    && curl -s -o /dev/null --max-time 2 "http://$probe_host:$DSH_PORT/"; then
    started=1
    break
  fi
  sleep 1
done
if (( started == 0 )); then
  printf '服务进程仍在运行，但 %s 秒内未响应 HTTP；请查看日志\n' "$DSH_START_TIMEOUT_SECONDS" >&2
fi
printf 'harness home：%s\n' "$DSH_HOME"
printf '服务监听地址：http://%s:%s\n' "$DSH_HOST" "$DSH_PORT"
if [[ -n "$DSH_PUBLIC_URL" ]]; then
  printf '对外访问地址：%s\n' "$DSH_PUBLIC_URL"
fi
printf '企业微信登录已强制启用；应用可见成员验证成功后才签发本地会话\n'
