#!/usr/bin/env bash
# Install the ComfyUI Pepper Pro is built against, its Python environment, and
# the custom node packs the shipped recipes pin.
#
#   scripts/install-comfy.sh [--packs-only]
#
#   COMFY_DIR     where ComfyUI goes        (default: the server's data/comfy/ComfyUI,
#                 which is where the server looks without COMFY_DIR)
#   COMFY_VENV    its virtual environment   (default: next to it, venv/)
#   TORCH_INDEX   the PyTorch wheel index   (default: CUDA 12.8; use
#                 https://download.pytorch.org/whl/cpu for a CPU-only checkout)
#   RECIPES_DIR   whose `nodes` to install  (default: ../recipes)
#
# With the defaults the server finds both; otherwise set COMFY_DIR and
# COMFY_PYTHON=$COMFY_VENV/bin/python.
#
# ComfyUI is pinned by tag *and* commit: the recipes' graphs are validated
# against this version's node types (test/fixtures/object_info.json), so
# bumping it means re-running validate-recipes with --write-fixture. Node packs
# are pinned by commit in each recipe and installed from that alone. Needs git
# and uv (https://docs.astral.sh/uv/).
set -euo pipefail

COMFY_TAG=v0.38.1
COMFY_COMMIT=20ca544ee0436721d8eb5f544665e490609f72c8
COMFY_REPO=https://github.com/comfyanonymous/ComfyUI

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMFY_DIR="${COMFY_DIR:-$HERE/../data/comfy/ComfyUI}"
COMFY_VENV="${COMFY_VENV:-$(dirname "$COMFY_DIR")/venv}"
TORCH_INDEX="${TORCH_INDEX:-https://download.pytorch.org/whl/cu128}"
RECIPES_DIR="${RECIPES_DIR:-$HERE/../recipes}"
PY="$COMFY_VENV/bin/python"

say() { printf '==> %s\n' "$*"; }
command -v uv >/dev/null || { echo "uv is required: https://docs.astral.sh/uv/getting-started/installation/" >&2; exit 1; }

if [[ "${1:-}" != "--packs-only" ]]; then
  if [[ -d "$COMFY_DIR/.git" ]]; then
    say "ComfyUI: fetching $COMFY_TAG into $COMFY_DIR"
    git -C "$COMFY_DIR" fetch --depth 1 origin "refs/tags/$COMFY_TAG:refs/tags/$COMFY_TAG"
    git -C "$COMFY_DIR" checkout -q "$COMFY_TAG"
  else
    say "ComfyUI: cloning $COMFY_TAG into $COMFY_DIR"
    git clone -q --depth 1 --branch "$COMFY_TAG" "$COMFY_REPO" "$COMFY_DIR"
  fi
  actual="$(git -C "$COMFY_DIR" rev-parse HEAD)"
  [[ "$actual" == "$COMFY_COMMIT" ]] || { echo "ComfyUI $COMFY_TAG is $actual, expected $COMFY_COMMIT" >&2; exit 1; }

  say "Python environment: $COMFY_VENV"
  [[ -x "$PY" ]] || uv venv -q --python 3.12 "$COMFY_VENV"
  # torch first, from its own index, so ComfyUI's requirements do not pull a
  # default build for a different CUDA.
  uv pip install -q --python "$PY" --index-url "$TORCH_INDEX" torch torchvision torchaudio
  uv pip install -q --python "$PY" -r "$COMFY_DIR/requirements.txt"
  # analyze jobs (python/analyze.py): beat tracking, vocal separation and
  # speech transcription. Checked when added: none changes the torch or
  # numpy ComfyUI runs on.
  uv pip install -q --python "$PY" librosa demucs soundfile openai-whisper
fi

# Every pack any recipe names, once: "name repo commit" per line.
packs="$(python3 - "$RECIPES_DIR" <<'EOF'
import json, sys
from pathlib import Path
seen = {}
for file in sorted(Path(sys.argv[1]).glob('*/recipe.json')):
    for pack in json.loads(file.read_text()).get('nodes', []):
        previous = seen.setdefault(pack['name'], pack)
        if (previous['repo'], previous['commit']) != (pack['repo'], pack['commit']):
            sys.exit(f"{file.parent.name} pins {pack['name']} at {pack['commit']}, another recipe at {previous['commit']}")
for pack in seen.values():
    # Fields are space-separated, lists comma-joined ("-" for none).
    print(pack['name'], pack['repo'], pack['commit'],
          ','.join(pack.get('skip_requirements', [])) or '-', ','.join(pack.get('pip', [])) or '-')
EOF
)"

if [[ -z "$packs" ]]; then
  say "no recipe uses a custom node pack"
else
  while read -r name repo commit skip extra; do
    dir="$COMFY_DIR/custom_nodes/$name"
    say "node pack $name @ ${commit:0:12}"
    [[ -d "$dir/.git" ]] || git clone -q "$repo" "$dir"
    git -C "$dir" fetch -q --depth 1 origin "$commit" 2>/dev/null || git -C "$dir" fetch -q origin
    git -C "$dir" checkout -q "$commit"
    if [[ -f "$dir/requirements.txt" ]]; then
      # A recipe can drop a requirement that would break the shared
      # environment (docs/PEPPER-PRO.md §5.4), matched by package name.
      reqs="$(mktemp)"
      if [[ "$skip" != "-" ]]; then
        grep -viE "^($(echo "$skip" | sed 's/,/|/g'))([<>=!~ ;\[]|$)" "$dir/requirements.txt" >"$reqs" || true
      else
        cp "$dir/requirements.txt" "$reqs"
      fi
      uv pip install -q --python "$PY" -r "$reqs"
      rm -f "$reqs"
    fi
    if [[ "$extra" != "-" ]]; then uv pip install -q --python "$PY" ${extra//,/ }; fi
  done <<<"$packs"
fi

say "done: COMFY_DIR=$COMFY_DIR COMFY_PYTHON=$PY"
