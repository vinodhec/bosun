#!/usr/bin/env bash
# Run the whole POC on one laptop: the platform page (a worktree on :3100) and the
# orchestrator (:7000) in loopback mode, no tunnel, no secret. Re-runnable.
#
#   bash dev-local.sh                 # uses ~/.claude-console (log it in first)
#   CLAUDE_CONFIG_DIR=~/.claude bash dev-local.sh   # or any other logged-in dir
set -euo pipefail

REPO="${REPO:-$HOME/maadiveedu-unified-platform}"                  # main checkout (sessions branch from it)
POC="${POC:-$HOME/Projects/mv-agent-console-poc}"                  # worktree with the /admin/chat-code page
HERE="$(cd "$(dirname "$0")" && pwd)"
LOG="${LOG:-$HOME/agent-console-logs}"; mkdir -p "$LOG" "$HOME/agent-sessions"
# Which Claude login runs turns. Unset = this machine's default login. To use a
# separate account: CLAUDE_CONFIG_DIR=~/.claude-console claude  (then /login), and
# pass the same variable to this script. Never point it at ~/.claude itself.
CFG="${CLAUDE_CONFIG_DIR:-}"
[ -z "$CFG" ] && [ -d "$HOME/.claude-console" ] && CFG="$HOME/.claude-console"
[ -n "$CFG" ] && [ ! -d "$CFG" ] && { echo "⚠ $CFG does not exist — using the default login"; CFG=""; }

# 1. The platform worktree needs the main checkout's untracked env + deps.
for l in node_modules web/node_modules web/.env.local shared-types/dist shared-services/dist shared-ui/dist; do
  [ -e "$POC/$l" ] || ln -s "$REPO/$l" "$POC/$l"
done
[ -e "$POC/web/.next/cache" ] || { mkdir -p "$POC/web/.next"; cp -Rc "$REPO/web/.next/cache" "$POC/web/.next/cache" 2>/dev/null || true; }
cat > "$POC/web/.env.development.local" <<EOF
# agent-console POC (local). Gitignored.
AGENT_CONSOLE_ENABLED=1
AGENT_CONSOLE_URL=http://localhost:7000
EOF

# 2. Restart the platform dev server on :3100.
pkill -f "$POC/web" 2>/dev/null || true; sleep 1
( cd "$POC/web" && PORT=3100 nohup yarn dev > "$LOG/platform-3100.log" 2>&1 & )

# 3. Restart the orchestrator on :7000 (loopback, unsigned session creation from loopback only).
OLD=$(lsof -ti tcp:7000 -sTCP:LISTEN 2>/dev/null || true); [ -n "$OLD" ] && kill $OLD; sleep 2
( cd "$HERE" && nohup env PORT=7000 HOST=127.0.0.1 REPO="$REPO" SESSIONS_DIR="$HOME/agent-sessions" \
  ${CFG:+CLAUDE_CONFIG_DIR="$CFG"} MODEL="${MODEL:-sonnet}" PUBLIC_URL=http://localhost:7000 LOCAL_UI=1 DEV_PORT0=3200 \
  node "$HERE/server.mjs" > "$LOG/orchestrator.log" 2>&1 & )

sleep 4
echo "── orchestrator ──"; cat "$LOG/orchestrator.log"
echo "── health ──"; curl -s http://127.0.0.1:7000/__console/api/health; echo
echo "── platform ──"; sleep 6; tail -3 "$LOG/platform-3100.log"
echo
echo "Open http://localhost:3100/admin/chat-code (superadmin login). Logs in $LOG/"
