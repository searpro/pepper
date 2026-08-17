# Pepper — CUDA image for RunPod (requirement 11).
#
# Follows the pattern of the sd-api image that is already working in
# production, with differences the new architecture forces:
#
#  * The SPA is built here rather than committed, so `server/public` is a build
#    artifact and never drifts from the source it was built from.
#  * `better-sqlite3` is a native module, so the builder stage carries a
#    toolchain and the production `npm ci` reuses the compiled binding rather
#    than rebuilding it in a runtime image that has no compiler.
#
# Backend binaries for sd-cpp/llama-cpp/audio-cpp are NOT baked in. They are
# downloaded at first boot from each backend's configured *_RELEASE_REPO into
# DATA_DIR/bin, which is on the persistent volume — so the image stays small
# and a backend can be updated without republishing it. Set
# AUTO_INSTALL_BACKENDS=false to manage them by hand.
#
# vLLM / vLLM-Omni is the one backend that IS baked in, both stages. Two
# reasons this is the exception rather than following the same pattern:
#
#  1. vLLM has no equivalent of "download one archive from a GitHub release" —
#     it's a PyTorch + CUDA wheel chain whose versions must match each other
#     exactly, which is precisely what vLLM-Omni's own published image already
#     gets right. Reassembling that at first boot on every deployment is the
#     version-skew risk the upstream image exists to avoid.
#  2. `better-sqlite3`'s native binding is glibc-ABI-sensitive: build it in a
#     Debian-based builder and run it in an Ubuntu-based CUDA image (or vice
#     versa) and a `GLIBC_x.xx not found` crash at startup is a real
#     possibility. Building it inside the *same* base as the runtime image
#     removes that risk entirely, at the cost of a heavier builder stage —
#     which is fine, since the builder stage is never shipped.
#
# NOTE: `vllm/vllm-omni` is assumed Ubuntu/Debian-based (apt available,
# NodeSource's Node 22 setup script works). Verify this against the actual
# image on the first build of this Dockerfile and adjust the `apt-get`
# invocations if it turns out to be a different base.
ARG VLLM_OMNI_IMAGE=vllm/vllm-omni:latest

FROM ${VLLM_OMNI_IMAGE} AS builder
WORKDIR /app

# Node.js 22 (for the build itself) plus python3/make/g++ (to compile
# better-sqlite3's binding against *this* image's glibc/Node ABI).
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates gnupg python3 make g++ \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
COPY server/package.json ./server/
COPY web/package.json ./web/
RUN npm ci

COPY tsconfig*.json ./
COPY server ./server
COPY web ./web

# The web build writes into server/public, which the server serves statically.
RUN npm run build --workspace web \
    && npm run build --workspace server

# Prune to production dependencies in place, keeping the native binding that
# was just compiled against this exact Node version.
RUN npm prune --omit=dev --workspace server


FROM ${VLLM_OMNI_IMAGE}
WORKDIR /app

# Node.js 22 to run the server itself. vLLM, PyTorch and CUDA come from the
# base image — this is the whole point of building on top of it rather than a
# slim Node base (see the note above the builder stage).
#
# ffmpeg is for speech-to-video: audio longer than one model window is sliced,
# generated a window at a time and stitched back together. libvulkan1 covers
# Vulkan builds of the .cpp backends (llama.cpp/audio.cpp still run
# CPU/Vulkan/CUDA per ACCEL, same as before — only vLLM is CUDA-only). git is
# used by the Python backend installer for git-sourced packages.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends \
        nodejs \
        libgomp1 \
        libvulkan1 \
        ffmpeg \
        git \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/server/package.json ./server/package.json
COPY --from=builder /app/server/dist ./server/dist
COPY --from=builder /app/server/public ./server/public

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data \
    ACCEL=cuda \
    AUTO_INSTALL_BACKENDS=true \
    VLLM_WORKER_MULTIPROC_METHOD=spawn

# The persistent volume mounts here: binaries, models, uploads and the
# database all live under it, so a redeploy keeps every gigabyte already
# downloaded.
VOLUME ["/data"]

EXPOSE 3000

# The server starts listening before backends are installed, so this passes
# during a cold start's multi-minute download instead of failing the container
# into a restart loop that never finishes it.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS http://127.0.0.1:${PORT}/health || exit 1

CMD ["node", "server/dist/index.js"]
