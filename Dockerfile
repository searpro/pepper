# Pepper — CUDA image for RunPod (requirement 11).
#
# Follows the pattern of the sd-api image that is already working in
# production, with two differences that the new architecture forces:
#
#  * The SPA is built here rather than committed, so `server/public` is a build
#    artifact and never drifts from the source it was built from.
#  * `better-sqlite3` is a native module, so the builder stage carries a
#    toolchain and the production `npm ci` reuses the compiled binding rather
#    than rebuilding it in a runtime image that has no compiler.
#
# Backend binaries are NOT baked in. They are downloaded at first boot from
# each backend's configured *_RELEASE_REPO into DATA_DIR/bin, which is on the
# persistent volume — so the image stays small and a backend can be updated
# without republishing it. Set AUTO_INSTALL_BACKENDS=false to manage them by
# hand.

FROM node:22-bookworm-slim AS builder
WORKDIR /app

# python3/make/g++ are needed only to compile better-sqlite3's binding.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
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


FROM node:22-bookworm-slim
WORKDIR /app

# Runtime libraries the backend binaries link against. libgomp1 is OpenMP
# (every ggml build), libvulkan1 covers Vulkan builds, and the CUDA runtime
# itself comes from the host through the NVIDIA container runtime — which is
# why this is a slim image and not a multi-gigabyte CUDA base.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libgomp1 \
        libvulkan1 \
        ca-certificates \
        curl \
        git \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/server/node_modules ./server/node_modules
COPY --from=builder /app/server/package.json ./server/package.json
COPY --from=builder /app/server/dist ./server/dist
COPY --from=builder /app/server/public ./server/public

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data \
    ACCEL=cuda \
    AUTO_INSTALL_BACKENDS=true

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
