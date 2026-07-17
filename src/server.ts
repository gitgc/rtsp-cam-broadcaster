/**
 * Fastify HTTP server. Serves:
 *   GET /                 the landing page (templated with title/tagline)
 *   GET /assets/*         page CSS + JS
 *   GET /vendor/*         hls.js (bundled from node_modules, no CDN needed)
 *   GET /hls/*            the live HLS playlist + segments
 *   GET /healthz          readiness/liveness based on segment freshness
 */

import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import type { Config } from './config.js';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(here, '../public');
const ASSETS_DIR = path.join(PUBLIC_DIR, 'assets');

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}

export async function buildServer(cfg: Config): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: cfg.logLevel }, trustProxy: true });

  // Page assets (styles.css, app.js).
  // `cacheControl: false` so our setHeaders owns the Cache-Control value
  // instead of @fastify/static writing its own (default max-age=0).
  // `no-cache` = the browser may store it but must revalidate first, so a
  // rebuilt app.js/styles.css takes effect on the next load (304 when unchanged
  // via the ETag @fastify/static sends). Avoids stale-player-after-deploy.
  await app.register(fastifyStatic, {
    root: ASSETS_DIR,
    prefix: '/assets/',
    cacheControl: false,
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
  });

  // hls.js, served straight from node_modules so the image stays self-contained.
  const hlsDistDir = path.dirname(require.resolve('hls.js'));
  await app.register(fastifyStatic, {
    root: hlsDistDir,
    prefix: '/vendor/',
    decorateReply: false,
    cacheControl: false,
    setHeaders: (res) => res.setHeader('Cache-Control', 'public, max-age=31536000, immutable'),
  });

  // Live HLS output. Segments get immutable long-cache (unique filenames);
  // the playlist gets a 1s cache so Cloudflare can micro-cache under load.
  await app.register(fastifyStatic, {
    root: cfg.hlsDir,
    prefix: '/hls/',
    decorateReply: false,
    cacheControl: false,
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.m3u8')) {
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Cache-Control', 'public, max-age=1');
      } else if (filePath.endsWith('.ts')) {
        res.setHeader('Content-Type', 'video/mp2t');
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  });

  // Landing page, rendered once at boot with the configured title/tagline.
  const template = await readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const page = template
    .split('{{TITLE}}')
    .join(escapeHtml(cfg.streamTitle))
    .split('{{TAGLINE}}')
    .join(escapeHtml(cfg.streamTagline));

  app.get('/', async (_req, reply) => {
    reply.header('Content-Type', 'text/html; charset=utf-8');
    reply.header('Cache-Control', 'no-cache');
    return reply.send(page);
  });

  const staleMs = Math.max(15000, cfg.hlsSegmentTime * 1000 * 5);
  app.get('/healthz', async (_req, reply) => {
    const playlist = path.join(cfg.hlsDir, 'stream.m3u8');
    try {
      const stats = await stat(playlist);
      const ageMs = Date.now() - stats.mtimeMs;
      if (ageMs > staleMs) return reply.code(503).send({ status: 'stale', ageMs });
      return reply.send({ status: 'ok', ageMs });
    } catch {
      return reply.code(503).send({ status: 'starting' });
    }
  });

  return app;
}
