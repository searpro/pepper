# Pepper — the default image, for RunPod and any other Docker GPU host.
#
#     docker build -t pepper .
#     docker run --gpus all -p 3000:3000 -v pepper-data:/data \
#       -e PEPPER_API_TOKEN=... pepper
#
# Deliberately small. Nothing GPU-specific is baked in, because nothing needs
# to be: the sd-cli, llama.cpp and audio.cpp releases Pepper installs each
# bundle their own CUDA runtime, and the Python runners bring a standalone
# interpreter and pinned wheels. All of that downloads on first boot into
# DATA_DIR/bin — on a network volume, so it happens once, not once per pod.
# The host supplies only the NVIDIA driver, which the container toolkit mounts
# in; the `nvidia/cuda` *base* flavour (no CUDA libraries, ~100 MB) is used for
# the environment it sets up for that, and for nvidia-smi, which the resource
# monitor reads.
#
# vLLM / vLLM-Omni is the exception and lives in Dockerfile.vllm, built on the
# multi-gigabyte vLLM-Omni image; use that only if you need the vllm backend.
#
# Ubuntu 22.04 on purpose: the backend forks are built on 22.04 (glibc 2.35),
# and upstream builds for 24.04 do not start on it — see DEFAULT_RELEASE_REPOS
# in server/src/config.ts.
ARG BASE_IMAGE=nvidia/cuda:12.4.1-base-ubuntu22.04

FROM ${BASE_IMAGE} AS builder
WORKDIR /app

# Node 22 for the build, plus a toolchain in case better-sqlite3 has no
# prebuilt binding for this Node ABI. Built on the runtime's own base so the
# binding links against the same glibc it will run with.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates gnupg python3 make g++ \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
COPY server/package.json ./server/
COPY web/package.json ./web/
RUN npm ci --no-audit --no-fund

COPY tsconfig*.json ./
COPY server ./server
COPY web ./web

# The web build writes into server/public, which the server serves statically.
RUN npm run build --workspace web \
    && npm run build --workspace server \
    && npm prune --omit=dev --workspace server


FROM ${BASE_IMAGE}
WORKDIR /app

# ffmpeg: speech-to-video slicing/stitching and MCP image previews. git: the
# Python backend installs git-sourced packages. libgomp1: sd-cli's CPU paths.
# tini: reaps the backend processes Pepper spawns and forwards signals.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs ffmpeg git libgomp1 tini \
    && rm -rf /var/lib/apt/lists/*

# cloudflared, for the named tunnel that gives every pod the same hostname.
RUN curl -fsSL -o /usr/local/bin/cloudflared \
        https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \
    && chmod +x /usr/local/bin/cloudflared \
    && cloudflared --version

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/server/package.json ./server/package.json
COPY --from=builder /app/server/dist ./server/dist
COPY --from=builder /app/server/public ./server/public
# The Python runners' code; their runtime installs into DATA_DIR on first use.
COPY --from=builder /app/server/python ./server/python
COPY deploy/runpod/entrypoint.mjs ./deploy/runpod/entrypoint.mjs

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data \
    ACCEL=cuda \
    AUTO_INSTALL_BACKENDS=true

# Binaries, models, uploads and the database. Mount the persistent volume here.
VOLUME ["/data"]
EXPOSE 3000

# The server listens before backends finish installing, so this passes during
# a cold start's long first download instead of restart-looping it.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS http://127.0.0.1:${PORT}/health || exit 1

# Runs Pepper, the tunnel when PEPPER_TUNNEL_TOKEN is set, and the optional
# idle shutdown; see the file for the environment it reads.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "deploy/runpod/entrypoint.mjs"]
