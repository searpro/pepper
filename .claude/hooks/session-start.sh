#!/usr/bin/env bash
# A cloud session starts from a fresh clone: install the workspaces so
# typecheck and the unit tests run at once. Local checkouts already have
# node_modules and are left alone.
set -euo pipefail
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0
cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}"
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  npm ci --no-audit --no-fund --loglevel=error >&2
fi
