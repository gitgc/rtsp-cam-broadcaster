
FROM node:26-alpine AS builder

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json tsconfig.server.json vite.config.ts ./
COPY src ./src

RUN npm run build && npm prune --omit=dev

FROM node:26-alpine AS runtime

ENV NODE_ENV=production \
    PORT=8080 \
    HLS_DIR=/hls

WORKDIR /app

RUN apk add --no-cache ffmpeg tini curl

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./

RUN mkdir -p "$HLS_DIR"

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/healthz" || exit 1

# tini reaps the ffmpeg child and forwards signals to node.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server/index.js"]
