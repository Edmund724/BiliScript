#!/bin/sh
set -eu

DEFAULT_ARCHIVE_URL="https://codeload.github.com/Edmund724/BiliScript/tar.gz/refs/heads/main"
DEFAULT_FALLBACK_BASE_URL="https://cdn.jsdelivr.net/gh/Edmund724/BiliScript@main/skills/biliscript"

SOURCE_DIR="${BILISCRIPT_INSTALL_SOURCE_DIR:-}"
SKILL_ROOT="${BILISCRIPT_SKILL_ROOT:-$HOME/.agents/skills}"
ARCHIVE_URL="${BILISCRIPT_INSTALL_ARCHIVE_URL:-$DEFAULT_ARCHIVE_URL}"
FALLBACK_BASE_URL="${BILISCRIPT_INSTALL_FALLBACK_BASE_URL:-$DEFAULT_FALLBACK_BASE_URL}"

die() {
  printf '%s\n' "BiliScript 本地 Agent 安装失败：$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
用法：install-agent.sh [--source-dir <dir>] [--skill-root <dir>]
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --source-dir)
      [ "$#" -ge 2 ] || die "--source-dir 缺少参数"
      SOURCE_DIR="$2"
      shift 2
      ;;
    --skill-root)
      [ "$#" -ge 2 ] || die "--skill-root 缺少参数"
      SKILL_ROOT="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "未知参数：$1"
      ;;
  esac
done

NODE_BIN=$(command -v node 2>/dev/null || true)
[ -n "$NODE_BIN" ] || die "未检测到 Node.js。请先安装 Node.js 22.20 或更高版本，再重新运行此命令。"

NODE_VER=$("$NODE_BIN" -p "process.versions.node" 2>/dev/null || true)
[ -n "$NODE_VER" ] || die "无法读取 Node.js 版本。请先安装 Node.js 22.20 或更高版本。"

NODE_MAJOR=${NODE_VER%%.*}
NODE_REST=${NODE_VER#*.}
NODE_MINOR=${NODE_REST%%.*}
case "$NODE_MAJOR" in
  ''|*[!0-9]*) die "无法识别 Node.js 版本：v$NODE_VER" ;;
esac
case "$NODE_MINOR" in
  ''|*[!0-9]*) die "无法识别 Node.js 版本：v$NODE_VER" ;;
esac
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 20 ]; }; then
  die "Node.js 版本过低（当前 v$NODE_VER）。请先安装 Node.js 22.20 或更高版本，再重新运行此命令。"
fi

TEMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/biliscript-install.XXXXXX")
STAGE_SAME_FS=""
BACKUP_DIR=""

cleanup() {
  if [ -n "$STAGE_SAME_FS" ] && [ -e "$STAGE_SAME_FS" ]; then
    rm -rf "$STAGE_SAME_FS" || true
  fi
  if [ -n "$BACKUP_DIR" ] && [ -e "$BACKUP_DIR" ]; then
    rm -rf "$BACKUP_DIR" || true
  fi
  if [ -n "${TEMP_DIR:-}" ] && [ -e "$TEMP_DIR" ]; then
    rm -rf "$TEMP_DIR" || true
  fi
}
trap cleanup EXIT HUP INT TERM

repair_session_proxy() {
  if [ -z "${HTTP_PROXY:-}${HTTPS_PROXY:-}${ALL_PROXY:-}${http_proxy:-}${https_proxy:-}${all_proxy:-}" ]; then
    return 0
  fi

  PROXY_REPORT=$("$NODE_BIN" -e '
    const net = require("node:net");
    const { execFileSync } = require("node:child_process");

    function testProxy(raw) {
      return new Promise((resolve) => {
        let url;
        try { url = new URL(raw); } catch { return resolve(false); }
        const port = Number(url.port) || (url.protocol === "https:" ? 443 : 80);
        if (!url.hostname || port <= 0) return resolve(false);
        const socket = net.connect({ host: url.hostname, port });
        let settled = false;
        const done = (ok) => {
          if (settled) return;
          settled = true;
          socket.destroy();
          resolve(ok);
        };
        socket.setTimeout(1000, () => done(false));
        socket.on("connect", () => done(true));
        socket.on("error", () => done(false));
      });
    }

    (async () => {
      const names = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"];
      const broken = [];
      const working = [];
      for (const name of names) {
        const val = process.env[name];
        if (!val) continue;
        if (await testProxy(val)) working.push(val);
        else broken.push(name);
      }
      if (!broken.length) return;

      let replacement = "";
      try {
        const candidate = execFileSync("git", ["config", "--global", "--get", "http.proxy"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
        if (candidate && await testProxy(candidate)) replacement = candidate;
      } catch {}
      if (!replacement && working.length) replacement = working[0];
      process.stdout.write(JSON.stringify({ broken, replacement }));
    })();
  ' 2>/dev/null || true)

  [ -n "$PROXY_REPORT" ] || return 0

  BROKEN_VARS=$("$NODE_BIN" -e 'const d = JSON.parse(process.argv[1]); process.stdout.write((d.broken || []).join(" "));' "$PROXY_REPORT")
  REPLACEMENT_PROXY=$("$NODE_BIN" -e 'const d = JSON.parse(process.argv[1]); process.stdout.write(d.replacement || "");' "$PROXY_REPORT")

  for var_name in $BROKEN_VARS; do
    unset "$var_name" || true
  done

  if [ -n "$REPLACEMENT_PROXY" ]; then
    export HTTP_PROXY="$REPLACEMENT_PROXY"
    export HTTPS_PROXY="$REPLACEMENT_PROXY"
    export http_proxy="$REPLACEMENT_PROXY"
    export https_proxy="$REPLACEMENT_PROXY"
    printf '%s\n' "已改用可用的 Git 代理配置（仅当前安装进程）。"
  else
    printf '%s\n' "已绕开失效的会话代理（$BROKEN_VARS），尝试直连（仅当前安装进程）。"
  fi
}

download_file() {
  url="$1"
  dest="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --connect-timeout 15 --max-time 60 "$url" -o "$dest"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$dest" -T 60 "$url"
  else
    die "未检测到 curl 或 wget，无法下载安装文件。"
  fi
}

STAGING="$TEMP_DIR/biliscript"
if [ -n "$SOURCE_DIR" ]; then
  [ -d "$SOURCE_DIR" ] || die "SourceDir 不是有效的目录：$SOURCE_DIR"
  RESOLVED_SOURCE=$(cd "$SOURCE_DIR" && pwd -P)
  if [ ! -f "$RESOLVED_SOURCE/SKILL.md" ] || [ ! -f "$RESOLVED_SOURCE/scripts/biliscript.mjs" ]; then
    die "SourceDir 不是有效的 BiliScript Skill 目录：$RESOLVED_SOURCE"
  fi
  mkdir -p "$STAGING"
  cp -Rp "$RESOLVED_SOURCE"/. "$STAGING"/
else
  repair_session_proxy
  ARCHIVE="$TEMP_DIR/biliscript.tar.gz"
  EXTRACT_DIR="$TEMP_DIR/archive"
  mkdir -p "$EXTRACT_DIR"
  TAR_OK=0
  if download_file "$ARCHIVE_URL" "$ARCHIVE" 2>/dev/null; then
    if tar -xzf "$ARCHIVE" -C "$EXTRACT_DIR" 2>/dev/null; then
      FOUND_SKILL=""
      for candidate in "$EXTRACT_DIR"/*/skills/biliscript "$EXTRACT_DIR"/skills/biliscript; do
        if [ -f "$candidate/SKILL.md" ] && [ -f "$candidate/scripts/biliscript.mjs" ]; then
          FOUND_SKILL="$candidate"
          break
        fi
      done
      if [ -n "$FOUND_SKILL" ]; then
        mkdir -p "$STAGING"
        cp -Rp "$FOUND_SKILL"/. "$STAGING"/
        TAR_OK=1
      fi
    fi
  fi

  if [ "$TAR_OK" -ne 1 ]; then
    printf '%s\n' "GitHub 归档下载失败，正在改用 jsDelivr 下载 Skill 与 CLI…"
    rm -rf "$STAGING"
    mkdir -p "$STAGING/scripts"
    download_file "$FALLBACK_BASE_URL/SKILL.md" "$STAGING/SKILL.md" \
      || die "从 jsDelivr 下载 SKILL.md 失败"
    download_file "$FALLBACK_BASE_URL/scripts/biliscript.mjs" "$STAGING/scripts/biliscript.mjs" \
      || die "从 jsDelivr 下载 scripts/biliscript.mjs 失败"
  fi
fi

if [ ! -f "$STAGING/SKILL.md" ] || [ ! -f "$STAGING/scripts/biliscript.mjs" ]; then
  die "安装文件不完整，缺少 SKILL.md 或 scripts/biliscript.mjs"
fi

mkdir -p "$SKILL_ROOT"
TARGET_ROOT=$(cd "$SKILL_ROOT" && pwd -P)
TARGET="$TARGET_ROOT/biliscript"

STAGE_SAME_FS=$(mktemp -d "$TARGET_ROOT/.biliscript-stage.XXXXXX")
cp -Rp "$STAGING"/. "$STAGE_SAME_FS"/

HAS_BACKUP=0
if [ -e "$TARGET" ] || [ -L "$TARGET" ]; then
  BACKUP_DIR=$(mktemp -d "$TARGET_ROOT/.biliscript-backup.XXXXXX")
  mv "$TARGET" "$BACKUP_DIR/biliscript"
  HAS_BACKUP=1
fi

if ! mv "$STAGE_SAME_FS" "$TARGET"; then
  if [ "$HAS_BACKUP" -eq 1 ] && [ -e "$BACKUP_DIR/biliscript" ]; then
    mv "$BACKUP_DIR/biliscript" "$TARGET" || true
  fi
  die "替换安装目录失败，已回滚原目录。"
fi
STAGE_SAME_FS=""
if [ -n "$BACKUP_DIR" ]; then
  rm -rf "$BACKUP_DIR"
  BACKUP_DIR=""
fi

USE_NODE_SIGNAL=0
case "$(uname -s 2>/dev/null || true)" in
  MINGW*|MSYS*|CYGWIN*) USE_NODE_SIGNAL=1 ;;
esac

signal_pid() {
  sig="$1"
  pid="$2"
  if [ "$USE_NODE_SIGNAL" -eq 1 ]; then
    node_sig="$sig"
    case "$sig" in
      TERM) node_sig="SIGTERM" ;;
      KILL) node_sig="SIGKILL" ;;
    esac
    "$NODE_BIN" -e '
      const pid = Number(process.argv[1]);
      const sig = process.argv[2] === "0" ? 0 : process.argv[2];
      try {
        process.kill(pid, sig);
      } catch (error) {
        process.exit(error && error.code === "ESRCH" ? 2 : 1);
      }
    ' "$pid" "$node_sig"
  else
    if [ "$sig" = "0" ]; then
      kill -0 "$pid" 2>/dev/null
    else
      kill -s "$sig" "$pid" 2>/dev/null
    fi
  fi
}

sleep_step() {
  if sleep 0.1 2>/dev/null; then
    return 0
  fi
  sleep 1
  return 1
}

get_bridge_status() {
  cli_path="$1"
  status_out=$("$NODE_BIN" "$cli_path" status 2>&1) || die "CLI status 失败：$status_out"
  "$NODE_BIN" -e 'JSON.parse(process.argv[1]);' "$status_out" >/dev/null 2>&1 \
    || die "CLI status 返回了无效 JSON：$status_out"
  printf '%s' "$status_out"
}

parse_pid() {
  "$NODE_BIN" -e '
    const data = JSON.parse(process.argv[1]);
    const pid = Number(data.daemonPid);
    if (!Number.isInteger(pid) || pid <= 0) process.exit(2);
    process.stdout.write(String(pid));
  ' "$1"
}

CLI="$TARGET/scripts/biliscript.mjs"
printf '%s\n' "BiliScript Skill 与 CLI 已安装到：$TARGET"
printf '%s\n' "正在重启本地 Bridge 以应用更新并检查扩展连接…"

PREV_STATUS=$(get_bridge_status "$CLI")
PREV_PID=$(parse_pid "$PREV_STATUS" 2>/dev/null || true)
[ -n "$PREV_PID" ] || die "CLI status 未返回有效的 daemonPid：$PREV_STATUS"

signal_pid TERM "$PREV_PID" || true
elapsed_tenths=0
while signal_pid 0 "$PREV_PID"; do
  if [ "$elapsed_tenths" -eq 30 ]; then
    signal_pid KILL "$PREV_PID" || true
  fi
  if [ "$elapsed_tenths" -ge 100 ]; then
    signal_pid KILL "$PREV_PID" || true
    die "旧 Bridge（PID $PREV_PID）未在 10 秒内退出"
  fi
  if sleep_step; then
    elapsed_tenths=$((elapsed_tenths + 1))
  else
    elapsed_tenths=$((elapsed_tenths + 10))
  fi
done

NEW_STATUS=$(get_bridge_status "$CLI")
NEW_PID=$(parse_pid "$NEW_STATUS" 2>/dev/null || true)
[ -n "$NEW_PID" ] || die "Bridge 重启后未返回有效的 daemonPid：$NEW_STATUS"
if [ "$NEW_PID" = "$PREV_PID" ]; then
  die "Bridge 重启失败：新进程 PID 仍为 $PREV_PID"
fi

printf '%s\n' "$NEW_STATUS"
EXT_ONLINE=$("$NODE_BIN" -e '
  const data = JSON.parse(process.argv[1]);
  process.stdout.write(data.extensionOnline === true ? "true" : "false");
' "$NEW_STATUS")

if [ "$EXT_ONLINE" = "true" ]; then
  printf '%s\n' "本地 Agent 已就绪，扩展连接正常。"
else
  printf '%s\n' "Bridge 已启动。请回到 BiliScript 扩展的「设置 → 本地 Agent」，点击「去连接」。"
fi

MCP_CONFIG=$("$NODE_BIN" -e '
  const path = require("node:path");
  const cliPath = path.resolve(process.argv[1]);
  const port = String(process.env.BILISCRIPT_BRIDGE_PORT || "").trim();
  const server = {
    command: process.execPath,
    args: [cliPath, "mcp"]
  };
  if (port && port !== "18492") {
    server.env = { BILISCRIPT_BRIDGE_PORT: port };
  }
  process.stdout.write(JSON.stringify({ mcpServers: { biliscript: server } }, null, 2));
' "$CLI")
printf '\n%s\n%s\n' "如需在纯对话桌面客户端（如 Claude Desktop、Cherry Studio、ChatWise）接入 MCP，可粘贴以下配置（已加载 Skill 的编程 Agent 无需重复配置）：" "$MCP_CONFIG"
