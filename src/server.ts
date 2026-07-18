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
import type { DetectionSource } from './frigate.js';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(here, '../public');
const ASSETS_DIR = path.join(PUBLIC_DIR, 'assets');

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}

export async function buildServer(
  cfg: Config,
  getDetections?: () => DetectionSource | undefined,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: cfg.logLevel }, trustProxy: true });

  // Presence beacons (navigator.sendBeacon) and keepalive fetches can arrive
  // with a Content-Type Fastify's built-in parsers reject (form-urlencoded,
  // octet-stream) or none at all, which would 415. These endpoints only need the
  // id from the query or a JSON body, so parse leniently rather than rejecting.
  const parseJsonish = (_req: unknown, body: string, done: (err: Error | null, value?: unknown) => void) => {
    if (!body) return done(null, {});
    try {
      done(null, JSON.parse(body));
    } catch {
      done(null, {});
    }
  };
  app.addContentTypeParser('text/plain', { parseAs: 'string' }, parseJsonish);
  app.addContentTypeParser('*', { parseAs: 'string' }, parseJsonish);

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
    // NEVER cache the live playlist. Even a couple of seconds of edge/browser
    // staleness can leave the player without the newest segment, so it drains
    // its buffer and stalls ("plays ~15s then reconnecting"). It's tiny anyway;
    // the bandwidth win is the immutable segments/images, which ARE cached.
    reply.header('Cache-Control', 'no-store');
    return reply.send(text);
  });

  // Live viewer counter. Heartbeats/leaves are POSTs (never CDN-cached) and
  // marked no-store; the count is held in memory with a TTL. See presence.ts.
  // TTL is ~2.5x the client heartbeat interval (20s) so a missed beat is fine.
  const presence = new Presence(50000);
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

  // Frigate detections: the last-seen animals + their snapshots. Populated only
  // when MQTT is configured; otherwise these return an empty list / 404.
  const knownLabels = new Set(cfg.frigate.labels);

  app.get('/api/detections', async (_req, reply) => {
    // Tiny JSON, polled every 30s — keep it fresh (not cached) so new sightings
    // appear promptly. The heavy part, the snapshot images, IS edge-cached.
    reply.header('Cache-Control', 'no-store');
    const items = (getDetections?.()?.list() ?? []).map((d) => ({
      label: d.label,
      camera: d.camera,
      lastSeen: d.lastSeen || null,
      score: d.score || null,
      image: `/api/detections/${encodeURIComponent(d.label)}/snapshot.jpg?ts=${d.imageAt ?? 0}`,
    }));
    return reply.send({ detections: items });
  });

  app.get('/api/detections/:label/snapshot.jpg', async (req, reply) => {
    const label = String((req.params as { label: string }).label).toLowerCase();
    if (!knownLabels.has(label)) return reply.code(404).send('unknown label');
    const image = getDetections?.()?.getImage(label);
    if (!image) return reply.code(404).send('no snapshot yet');
    reply.header('Content-Type', 'image/jpeg');
    // The URL's ?ts changes whenever the image does, so each version is
    // immutable — the edge serves it and origin sends each snapshot just once.
    reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    return reply.send(image);
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
