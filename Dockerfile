# syntax=docker/dockerfile:1

# ── Build stage: compile TypeScript, then prune to production deps ────────────
FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ── Runtime stage ────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
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

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./
COPY public ./public

RUN mkdir -p "$HLS_DIR"

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/healthz" || exit 1

# tini reaps the ffmpeg/cloudflared children and forwards signals to node.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
