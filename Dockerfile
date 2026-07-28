# syntax=docker/dockerfile:1

# ── Build stage: bundle the React client + compile the server, then prune ─────
FROM node:26-alpine AS builder
WORKDIR /app

# Playwright is a devDependency (browser tests only) and its postinstall would
# otherwise pull ~150MB of browsers into a stage that never runs them.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json tsconfig.server.json vite.config.ts ./
COPY src ./src
# vite build -> dist/client (hashed JS/CSS + index.html)
# tsc        -> dist/server + dist/shared
RUN npm run build && npm prune --omit=dev

# ── Runtime stage ────────────────────────────────────────────────────────────
FROM node:26-alpine AS runtime
ENV NODE_ENV=production \
    PORT=8080 \
    HLS_DIR=/hls

WORKDIR /app

# ffmpeg (RTSP→HLS remux), tini (PID 1 / signal handling), curl (healthcheck).
RUN apk add --no-cache ffmpeg tini curl

# cloudflared — static Go binary, picked to match the build architecture.
# TARGETARCH is set automatically by buildx; falls back to `uname -m` for a
# plain `docker build` on the host.
ARG TARGETARCH
RUN set -eux; \
    arch="${TARGETARCH:-}"; \
    if [ -z "$arch" ]; then \
      case "$(uname -m)" in \
        x86_64) arch=amd64 ;; \
        aarch64) arch=arm64 ;; \
        armv7l | armv6l | arm) arch=arm ;; \
        *) arch=amd64 ;; \
      esac; \
    fi; \
    case "$arch" in \
      amd64) cf=amd64 ;; \
      arm64) cf=arm64 ;; \
      arm) cf=arm ;; \
      *) cf=amd64 ;; \
    esac; \
    wget -O /usr/local/bin/cloudflared \
      "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${cf}"; \
    chmod +x /usr/local/bin/cloudflared; \
    /usr/local/bin/cloudflared --version

# dist/client is the built front-end; the server reads index.html from there and
# serves dist/client/assets at /assets. No separate public/ directory any more.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./

RUN mkdir -p "$HLS_DIR"

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/healthz" || exit 1

# tini reaps the ffmpeg/cloudflared children and forwards signals to node.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server/index.js"]
