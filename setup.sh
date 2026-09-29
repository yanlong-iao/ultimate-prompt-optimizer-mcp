#!/usr/bin/env bash
# One-shot setup for Ultimate Prompt Optimizer MCP (macOS / Linux, bash 3.2+).
#   bash setup.sh
# Re-runnable: keeps an existing .env unless you choose to overwrite it; backs up Claude configs before editing.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"
NAME="ultimate-prompt-optimizer"

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✔\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '  \033[31m✘\033[0m %s\n' "$*"; exit 1; }

# ask VAR "prompt" "default" [secret]
ask() {
  local var="$1" prompt="$2" def="${3:-}" secret="${4:-}" ans=""
  if [ -n "${UPO_NONINTERACTIVE:-}" ]; then
    ans="${!var:-$def}"
  elif [ -n "$secret" ]; then
    printf '  %s%s: ' "$prompt" "$([ -n "$def" ] && echo ' [已有值，回车保留]')"
    IFS= read -rs ans </dev/tty || true; echo
    [ -z "$ans" ] && ans="$def"
  else
    printf '  %s%s: ' "$prompt" "$([ -n "$def" ] && echo " [$def]")"
    IFS= read -r ans </dev/tty || true
    [ -z "$ans" ] && ans="$def"
  fi
  printf -v "$var" '%s' "$ans"
}

yesno() { # yesno "question" default(y/n)
  local def="$2" ans=""
  if [ -n "${UPO_NONINTERACTIVE:-}" ]; then [ "$def" = "y" ]; return; fi
  printf '  %s [%s]: ' "$1" "$([ "$def" = y ] && echo Y/n || echo y/N)"
  IFS= read -r ans </dev/tty || true
  ans="${ans:-$def}"
  case "$ans" in [Yy]*) return 0 ;; *) return 1 ;; esac
}

# dotenv-safe quoting
envq() {
  case "$1" in
    *"'"*) printf '"%s"' "$1" ;;
    *) printf "'%s'" "$1" ;;
  esac
}

# ───────────────────────────── 1. Node ─────────────────────────────
bold "1/5 检查 Node.js"
NODE_BIN="$(command -v node || true)"
[ -z "$NODE_BIN" ] && die "没找到 node。先安装 Node.js 20+：brew install node   或到 https://nodejs.org 下载，然后重新运行 bash setup.sh"
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -lt 20 ] && die "Node 版本太旧 ($("$NODE_BIN" -v))，需要 20+：brew upgrade node"
ok "node $("$NODE_BIN" -v) at $NODE_BIN"

# ───────────────────────────── 2. Build ─────────────────────────────
bold "2/5 安装依赖并构建"
if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi
npm run build
ok "dist/index.js 已生成"

# ───────────────────────────── 3. .env ─────────────────────────────
bold "3/5 配置 .env"
WRITE_ENV=1
if [ -f .env ]; then
  if yesno ".env 已存在，要重新填写吗？" n; then WRITE_ENV=1; else WRITE_ENV=0; ok "保留现有 .env"; fi
fi

if [ "$WRITE_ENV" = 1 ]; then
  echo "  （直接回车 = 使用方括号里的默认值；密码/Key 输入时不显示）"
  ask PO_BASE_URL        "prompt-optimizer 部署地址（没有部署就直接回车，使用内置模板库）" "${PO_BASE_URL:-}"
  PO_ACCESS_PASSWORD="${PO_ACCESS_PASSWORD:-}"
  [ -n "$PO_BASE_URL" ] && ask PO_ACCESS_PASSWORD "部署的访问密码 ACCESS_PASSWORD（没设就直接回车）" "$PO_ACCESS_PASSWORD" secret
  ask LLM_BASE_URL       "LLM 接口地址（OpenAI 兼容）" "${LLM_BASE_URL:-https://api.deepseek.com}"
  ask LLM_API_KEY        "LLM API Key" "${LLM_API_KEY:-}" secret
  ask LLM_MODEL          "模型名" "${LLM_MODEL:-deepseek-flash}"

  [ -f .env ] && cp .env ".env.bak.$(date +%s)"
  {
    echo "PO_BASE_URL=$(envq "$PO_BASE_URL")"
    echo "PO_ACCESS_PASSWORD=$(envq "$PO_ACCESS_PASSWORD")"
    echo "PO_ACCESS_USERNAME='admin'"
    echo "PO_AUTH_MODE='auto'"
    if [ -n "$PO_BASE_URL" ]; then echo "PO_BACKEND='auto'"; else echo "PO_BACKEND='local'"; fi
    echo "PO_TIMEOUT_MS=180000"
    echo "LLM_BASE_URL=$(envq "$LLM_BASE_URL")"
    echo "LLM_API_KEY=$(envq "$LLM_API_KEY")"
    echo "LLM_MODEL=$(envq "$LLM_MODEL")"
    echo "UPO_MAX_CALLS=80"
    echo "UPO_CACHE=true"
    echo "# LLM_PRICE_INPUT_PER_M=0.30"
    echo "# LLM_PRICE_OUTPUT_PER_M=1.20"
    echo "LOG_LEVEL='info'"
  } > .env
  chmod 600 .env
  ok ".env 已写入（权限 600）"
  [ -z "$LLM_API_KEY" ] && warn "没填 LLM_API_KEY：LangGPT 只能用模板生成，评测会是 mock 模式"
else
  set -a; . ./.env; set +a
fi

# ─────────────── 4. Optional: start prompt-optimizer in Docker ───────────────
bold "4/5 上游 prompt-optimizer"
PO_BASE_URL="${PO_BASE_URL:-}"
if [ -z "$PO_BASE_URL" ]; then
  ok "未配置 PO_BASE_URL：使用内置模板库 + 你的 LLM（推荐）"
else
  CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 "$PO_BASE_URL/" || true)"
  if [ "$CODE" != "000" ]; then
    ok "$PO_BASE_URL 可访问 (HTTP $CODE)"
  elif [[ "$PO_BASE_URL" =~ ^http://(localhost|127\.0\.0\.1):([0-9]+)/?$ ]] && command -v docker >/dev/null 2>&1; then
    PORT="${BASH_REMATCH[2]}"
    if [ -z "${LLM_API_KEY:-}" ]; then
      warn "$PO_BASE_URL 没有运行，而上游容器也需要 LLM Key，先跳过（可稍后重跑本脚本）"
    elif yesno "$PO_BASE_URL 没有运行。用 Docker 启动 prompt-optimizer 吗？" y; then
      docker rm -f prompt-optimizer >/dev/null 2>&1 || true
      set -- -d --name prompt-optimizer --restart unless-stopped -p "$PORT:80"
      [ -n "${PO_ACCESS_PASSWORD:-}" ] && set -- "$@" -e "ACCESS_PASSWORD=$PO_ACCESS_PASSWORD"
      case "${LLM_BASE_URL:-}" in
        https://api.openai.com*) set -- "$@" -e "VITE_OPENAI_API_KEY=$LLM_API_KEY" -e MCP_DEFAULT_MODEL_PROVIDER=openai ;;
        *) set -- "$@" -e "VITE_CUSTOM_API_KEY=$LLM_API_KEY" -e "VITE_CUSTOM_API_BASE_URL=$LLM_BASE_URL" \
                       -e "VITE_CUSTOM_API_MODEL=${LLM_MODEL:-}" -e MCP_DEFAULT_MODEL_PROVIDER=custom ;;
      esac
      docker run "$@" -e MCP_LOG_LEVEL=info linshen/prompt-optimizer:latest >/dev/null
      printf '  等待容器启动'
      for _ in $(seq 1 40); do
        CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$PO_BASE_URL/" || true)"
        [ "$CODE" != "000" ] && break
        printf '.'; sleep 2
      done
      echo
      [ "$CODE" != "000" ] && ok "prompt-optimizer 已在 $PO_BASE_URL 运行（MCP: $PO_BASE_URL/mcp）" || warn "容器还没就绪，可用 docker logs prompt-optimizer 查看"
    fi
  else
    warn "$PO_BASE_URL 目前连不上（没装 Docker 或不是本机地址）。没关系：配置了 LLM Key 时会自动用本地 LLM 优化"
  fi
fi

# ───────────────────────────── 5. Register ─────────────────────────────
bold "5/5 注册到 Claude"
ENTRY="$DIR/dist/index.js"

case "$(uname -s)" in
  Darwin) DESKTOP_CFG="$HOME/Library/Application Support/Claude/claude_desktop_config.json" ;;
  *)      DESKTOP_CFG="${XDG_CONFIG_HOME:-$HOME/.config}/Claude/claude_desktop_config.json" ;;
esac

if [ -d "$(dirname "$DESKTOP_CFG")" ] || [ "$(uname -s)" = Darwin ]; then
  mkdir -p "$(dirname "$DESKTOP_CFG")"
  [ -f "$DESKTOP_CFG" ] && cp "$DESKTOP_CFG" "$DESKTOP_CFG.bak.$(date +%s)"
  CFG="$DESKTOP_CFG" NODE_BIN="$NODE_BIN" ENTRY="$ENTRY" SRV="$NAME" "$NODE_BIN" -e '
    const fs = require("fs");
    const p = process.env.CFG;
    let cfg = {};
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, "utf8").trim();
      if (raw) { try { cfg = JSON.parse(raw); } catch (e) { console.error("  ✘ claude_desktop_config.json 不是合法 JSON，未修改（已备份）"); process.exit(2); } }
    }
    cfg.mcpServers = cfg.mcpServers || {};
    cfg.mcpServers[process.env.SRV] = { command: process.env.NODE_BIN, args: [process.env.ENTRY] };
    fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
  ' && ok "Claude Desktop 已配置：$DESKTOP_CFG"
else
  warn "没检测到 Claude Desktop 配置目录，跳过"
fi

if command -v claude >/dev/null 2>&1; then
  claude mcp remove "$NAME" --scope user >/dev/null 2>&1 || true
  if claude mcp add "$NAME" --scope user -- "$NODE_BIN" "$ENTRY" >/dev/null 2>&1; then
    ok "Claude Code 已注册（user scope）"
  else
    warn "Claude Code 注册失败，可手动运行：claude mcp add $NAME --scope user -- \"$NODE_BIN\" \"$ENTRY\""
  fi
else
  warn "没检测到 claude 命令行（Claude Code），跳过；以后装了再重跑本脚本即可"
fi

# ───────────────────────────── Check ─────────────────────────────
bold "自检（模拟 Claude 启动服务器）"
"$NODE_BIN" scripts/check.mjs || warn "自检有问题，见上方输出"

bold "完成 🎉"
echo "  下一步：完全退出 Claude Desktop（Cmd+Q）再打开，在对话里说："
echo "  「用 optimizer_connection_status 检查连接」"
