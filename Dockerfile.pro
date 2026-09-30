# Pepper Pro — production image, video and audio through ComfyUI recipes.
#
#     docker build -f Dockerfile.pro -t pepper-pro .
#     docker run --gpus all -p 3000:3000 -v pepper-pro-data:/data \
#       -e PEPPER_API_TOKEN=... -e PEPPER_TIER=24gb-64ram pepper-pro
#
# Unlike Pepper's image, the generative engine is baked in: ComfyUI at the
# pinned tag, its Python environment (torch for CUDA 12.8, so Ada, Hopper and
# Blackwell cards all work), and the custom node packs the recipes pin. Model
# weights are not: recipes download them into /data on install, once per
# network volume. llama.cpp is installed on first boot like Pepper's backends.
#
# The build ends by starting ComfyUI on the CPU and validating every recipe
# against it (scripts/smoke-comfy.sh), so an image whose ComfyUI or node packs
# no longer match its recipes fails here rather than on a pod.
ARG BASE_IMAGE=nvidia/cuda:12.8.1-base-ubuntu22.04

FROM ${BASE_IMAGE} AS builder
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates gnupg python3 make g++ \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
COPY packages/core/package.json ./packages/core/
COPY packages/ui/package.json ./packages/ui/
COPY apps/pepper/server/package.json ./apps/pepper/server/
COPY apps/pepper/web/package.json ./apps/pepper/web/
COPY apps/pepper-pro/server/package.json ./apps/pepper-pro/server/
COPY apps/pepper-pro/web/package.json ./apps/pepper-pro/web/
RUN npm ci --no-audit --no-fund

COPY packages/core ./packages/core
COPY packages/ui ./packages/ui
COPY apps/pepper-pro/server ./apps/pepper-pro/server
COPY apps/pepper-pro/web ./apps/pepper-pro/web

# The web build writes into apps/pepper-pro/server/public.
RUN npm run build:pro \
    && npm prune --omit=dev --workspace @pepper-pro/server --workspace @pepper/core


FROM ${BASE_IMAGE}
WORKDIR /app

# ffmpeg: cut rendering and media probes. git: node packs. tini: reaps
# ComfyUI and llama.cpp. libgl1/libglib2.0-0: opencv, which several packs import.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs ffmpeg git tini libgl1 libglib2.0-0 python3 \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL -o /usr/local/bin/cloudflared \
        https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \
    && chmod +x /usr/local/bin/cloudflared \
    && cloudflared --version

COPY --from=ghcr.io/astral-sh/uv:0.8 /uv /usr/local/bin/uv

# ComfyUI and torch: several GB, rebuilt only when the install script (which
# holds the pin) changes. uv puts its Python under /opt so the venv survives
# the cache cleanup.
ENV COMFY_DIR=/opt/comfy/ComfyUI \
    COMFY_VENV=/opt/comfy/venv \
    COMFY_PYTHON=/opt/comfy/venv/bin/python \
    UV_PYTHON_INSTALL_DIR=/opt/uv-python \
    UV_NO_CACHE=1
COPY apps/pepper-pro/server/scripts/install-comfy.sh ./apps/pepper-pro/server/scripts/install-comfy.sh
RUN mkdir -p /tmp/no-recipes \
    && RECIPES_DIR=/tmp/no-recipes apps/pepper-pro/server/scripts/install-comfy.sh \
    && rm -rf /root/.cache /tmp/*

# Node packs: only what the recipes pin, rebuilt when a recipe changes.
COPY apps/pepper-pro/server/recipes ./apps/pepper-pro/server/recipes
RUN apps/pepper-pro/server/scripts/install-comfy.sh --packs-only && rm -rf /root/.cache

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/packages/core/package.json ./packages/core/package.json
COPY --from=builder /app/packages/core/dist ./packages/core/dist
COPY --from=builder /app/apps/pepper-pro/server/package.json ./apps/pepper-pro/server/package.json
COPY --from=builder /app/apps/pepper-pro/server/dist ./apps/pepper-pro/server/dist
COPY --from=builder /app/apps/pepper-pro/server/public ./apps/pepper-pro/server/public
COPY apps/pepper-pro/server/python ./apps/pepper-pro/server/python
COPY apps/pepper-pro/server/golden ./apps/pepper-pro/server/golden
COPY apps/pepper-pro/server/scripts/smoke-comfy.sh ./apps/pepper-pro/server/scripts/smoke-comfy.sh
COPY deploy/runpod/entrypoint.mjs ./deploy/runpod/entrypoint.mjs

RUN cd apps/pepper-pro/server && scripts/smoke-comfy.sh

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data \
    ACCEL=cuda \
    AUTO_INSTALL_BACKENDS=true \
    PEPPER_APP=apps/pepper-pro/server/dist/index.js

VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS http://127.0.0.1:${PORT}/health || exit 1

ENTRYPOINT ["/usr/bin/tini", "-s", "--"]
CMD ["node", "deploy/runpod/entrypoint.mjs"]
