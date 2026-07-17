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
import { Presence } from './presence.js';

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

  // Serve the live playlist with a spec-compliant TARGETDURATION. With -c copy
  // we can only cut on camera keyframes, so segments run slightly over the
  // rounded target (e.g. 4.04s vs TARGETDURATION:4) — which iOS's strict native
  // HLS player rejects, causing constant "reconnecting". Segments are untouched;
  // we just raise the declared target to ceil(longest segment). This exact route
  // takes precedence over the /hls/* static handler for the playlist only.
  app.get('/hls/stream.m3u8', async (_req, reply) => {
    let text: string;
    try {
      text = await readFile(path.join(cfg.hlsDir, 'stream.m3u8'), 'utf8');
    } catch {
      return reply.code(404).header('Cache-Control', 'no-store').send('playlist not ready\n');
    }
    const durations = [...text.matchAll(/#EXTINF:([\d.]+)/g)].map((m) => parseFloat(m[1] ?? '0'));
    if (durations.length > 0) {
      const compliant = Math.ceil(Math.max(...durations));
      text = text.replace(/#EXT-X-TARGETDURATION:\d+/, `#EXT-X-TARGETDURATION:${compliant}`);
    }
    reply.header('Content-Type', 'application/vnd.apple.mpegurl');
    reply.header('Cache-Control', 'no-cache'); // live playlist must never be cached stale
    return reply.send(text);
  });

  // Live viewer counter. Heartbeats/leaves are POSTs (never CDN-cached) and
  // marked no-store; the count is held in memory with a TTL. See presence.ts.
  const presence = new Presence();
  const isValidId = (id: unknown): id is string =>
    typeof id === 'string' && id.length > 0 && id.length <= 64;

  app.post('/api/heartbeat', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const id = (req.body as { id?: unknown } | undefined)?.id;
    if (!isValidId(id)) return reply.code(400).send({ error: 'invalid id' });
    return reply.send({ viewers: presence.heartbeat(id) });
  });

  app.post('/api/leave', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const id = (req.query as { id?: unknown }).id; // sent via navigator.sendBeacon
    if (isValidId(id)) presence.leave(id);
    return reply.send({ ok: true });
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
