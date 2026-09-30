# Pepper — the default image, for RunPod and any other Docker GPU host.
#
#     docker build -t pepper .
#     docker run --gpus all -p 3000:3000 -v pepper-data:/data \
#       -e PEPPER_API_TOKEN=... pepper
#
# The .cpp backends are not baked in, because they need not be: the sd-cli,
# llama.cpp and audio.cpp releases Pepper installs each bundle their own CUDA
# runtime and download in about a minute on first boot into DATA_DIR/bin — on
# a network volume, so it happens once, not once per pod. The Python runner
# environment (torch and friends, for SeedVR2 upscaling and the Python video
# runners) is the exception and is baked in; see PYTHON_DIR below.
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
# in apps/pepper/server/src/config.ts.
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
COPY packages/core/package.json ./packages/core/
COPY packages/ui/package.json ./packages/ui/
COPY apps/pepper/server/package.json ./apps/pepper/server/
COPY apps/pepper/web/package.json ./apps/pepper/web/
# The lockfile covers every workspace, so npm ci needs Pepper Pro's manifests too.
COPY apps/pepper-pro/server/package.json ./apps/pepper-pro/server/
COPY apps/pepper-pro/web/package.json ./apps/pepper-pro/web/
RUN npm ci --no-audit --no-fund

COPY packages/core ./packages/core
COPY packages/ui ./packages/ui
COPY apps/pepper/server ./apps/pepper/server
COPY apps/pepper/web ./apps/pepper/web

# The web build writes into apps/pepper/server/public, which the server
# serves statically. The core is built first: the server compiles against its
# declarations and runs its JavaScript.
RUN npm run build --workspace @pepper/core \
    && npm run build --workspace @pepper/web \
    && npm run build --workspace @pepper/server \
    && npm prune --omit=dev --workspace @pepper/server --workspace @pepper/core


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
COPY --from=builder /app/packages/core/package.json ./packages/core/package.json
COPY --from=builder /app/apps/pepper/server/package.json ./apps/pepper/server/package.json

# The Python runner environment (standalone interpreter, torch, diffusers,
# spandrel, the SeedVR2 checkout), installed by the server's own installer so
# its receipts match what the server looks for. Baked in rather than installed
# at first use: pip writing torch onto a RunPod network volume took over twenty
# minutes. It adds several GB to the image, pulled once per host. Per-model
# isolated environments (YuE2) are still built on first use, under the same
# directory on the container's local disk.
#
# Only the installer's own files and requirements.txt are copied before it
# runs, so this multi-gigabyte layer is rebuilt when they change and not on
# every server edit. The list is the installer's import closure, core
# included; a new import there fails this step loudly rather than silently.
ENV PYTHON_DIR=/opt/pepper-python
COPY --from=builder /app/apps/pepper/server/dist/scripts/install-python.js ./apps/pepper/server/dist/scripts/install-python.js
COPY --from=builder /app/apps/pepper/server/dist/backends/python.js /app/apps/pepper/server/dist/backends/python-packages.js ./apps/pepper/server/dist/backends/
COPY --from=builder /app/apps/pepper/server/dist/paths.js ./apps/pepper/server/dist/paths.js
COPY --from=builder /app/packages/core/dist/db/settings.js /app/packages/core/dist/db/schema.js ./packages/core/dist/db/
COPY --from=builder /app/packages/core/dist/errors.js /app/packages/core/dist/paths.js /app/packages/core/dist/config.js ./packages/core/dist/
COPY --from=builder /app/apps/pepper/server/python/requirements.txt ./apps/pepper/server/python/requirements.txt
RUN PIP_NO_CACHE_DIR=1 node apps/pepper/server/dist/scripts/install-python.js \
    && rm -rf /root/.cache /tmp/*

COPY --from=builder /app/packages/core/dist ./packages/core/dist
COPY --from=builder /app/apps/pepper/server/dist ./apps/pepper/server/dist
COPY --from=builder /app/apps/pepper/server/public ./apps/pepper/server/public
# The Python runners' code (their environment is the layer above).
COPY --from=builder /app/apps/pepper/server/python ./apps/pepper/server/python
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
# idle shutdown; see the file for the environment it reads. `-s` makes tini a
# subreaper: RunPod starts containers under its own init, so tini is not PID 1
# and would otherwise not reap the backend processes Pepper spawns.
ENTRYPOINT ["/usr/bin/tini", "-s", "--"]
CMD ["node", "deploy/runpod/entrypoint.mjs"]
