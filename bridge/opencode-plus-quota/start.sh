#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
state_dir="${XDG_STATE_HOME:-/root/.local/state}/opencode-enhancement-suite"
mkdir -p "${state_dir}"
if [ -z "${OPENROUTER_MANAGEMENT_KEY:-}" ] && command -v op >/dev/null 2>&1; then
  OPENROUTER_MANAGEMENT_KEY="$(op item get "OpenRouter.ai Management Key" --vault Private --fields notesPlain --reveal 2>/dev/null || true)"
  export OPENROUTER_MANAGEMENT_KEY
fi
nohup node server.mjs > "${state_dir}/bridge.log" 2>&1 &
echo $! > "${state_dir}/bridge.pid"
echo "OpenCode Enhancement Suite bridge started on http://127.0.0.1:18765"
