#!/usr/bin/env bash
# Start the installed ComfyUI on the CPU, validate every shipped recipe against
# its node types, and stop it. The image build runs this so an image whose
# ComfyUI or node packs no longer match its recipes is never published.
#
#   COMFY_DIR=… COMFY_PYTHON=… scripts/smoke-comfy.sh   (from apps/pepper-pro/server, after a build)
set -euo pipefail

PORT="${SMOKE_PORT:-8199}"
WORK="$(mktemp -d)"
trap 'kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; rm -rf "$WORK"' EXIT

# The same flags the server passes (src/backends.ts), minus the GPU, with
# every installed pack whitelisted (the image installs only recipes' packs).
packs=()
for dir in "$COMFY_DIR"/custom_nodes/*/; do
  if [[ -d "$dir" && "$dir" != *__pycache__* ]]; then packs+=("$(basename "$dir")"); fi
done
mkdir -p "$WORK/in" "$WORK/out" "$WORK/tmp" "$WORK/user"
"$COMFY_PYTHON" "$COMFY_DIR/main.py" --cpu --listen 127.0.0.1 --port "$PORT" \
  --disable-auto-launch --disable-api-nodes --disable-all-custom-nodes \
  ${packs[@]+--whitelist-custom-nodes "${packs[@]}"} \
  --input-directory "$WORK/in" --output-directory "$WORK/out" --temp-directory "$WORK/tmp" --user-directory "$WORK/user" \
  >"$WORK/comfy.log" 2>&1 &
pid=$!

for _ in $(seq 1 120); do
  curl -fsS "http://127.0.0.1:$PORT/system_stats" >/dev/null 2>&1 && break
  kill -0 "$pid" 2>/dev/null || { cat "$WORK/comfy.log"; echo "ComfyUI exited during startup" >&2; exit 1; }
  sleep 1
done
curl -fsS "http://127.0.0.1:$PORT/system_stats" >/dev/null || { cat "$WORK/comfy.log"; echo "ComfyUI did not start" >&2; exit 1; }

node dist/scripts/validate-recipes.js --comfy "http://127.0.0.1:$PORT"
