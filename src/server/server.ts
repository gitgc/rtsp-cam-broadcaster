/**
 * Fastify HTTP server. Serves:
 *   GET /                          the React app's index.html, templated at boot
 *   GET /assets/*                  hashed JS/CSS bundles from the Vite build
 *   GET /hls/*                     the live HLS playlist + segments
 *   POST /api/heartbeat|leave      live viewer presence
 *   GET /api/detections[/…]        Frigate sightings + snapshots
 *   GET /healthz                   readiness/liveness based on segment freshness
 */

import fastifyStatic from '@fastify/static'
import Fastify, { type FastifyInstance } from 'fastify'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AppBootstrap, DetectionDto } from '../shared/types.js'
import type { Config } from './config.js'
import { SNAPSHOT_HASH_LENGTH, type DetectionSource } from './frigate.js'
import { Presence } from './presence.js'

/** Snapshot URL segments are lowercase hex of exactly this length. */
const SNAPSHOT_HASH_PATTERN = new RegExp(`^[0-9a-f]{${SNAPSHOT_HASH_LENGTH}}$`)

const here = path.dirname(fileURLToPath(import.meta.url))
/** dist/server -> dist/client, where `vite build` puts the compiled front-end. */
const DEFAULT_CLIENT_DIR = path.resolve(here, '../client')

export interface ServerOptions {
  /** Bridges to the Frigate MQTT client, which is constructed after the server. */
  getDetections?: () => DetectionSource | undefined
  /** Overrides the built client location. Tests point this at a fixture. */
  clientDir?: string
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  )
}

/**
 * Escapes a JSON blob for embedding in a `<script>` element: `<` and friends
 * become `\uXXXX` escapes, which are still valid JSON but can no longer close
 * the script tag early. Without this, a STREAM_TITLE containing `</script>`
 * would inject markup into the page.
 */
function escapeJsonForScript(json: string): string {
  // U+2028/U+2029 are line terminators to a JS parser but legal inside a JSON
  // string, so they get escaped alongside the markup characters.
  const UNSAFE = /[<>&\u2028\u2029]/g
  return json.replace(UNSAFE, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

/**
 * Fills the `{{TITLE}}` / `{{TAGLINE}}` / `{{BOOTSTRAP}}` placeholders that
 * `vite build` leaves in index.html. Doing it here (once, at boot) keeps the
 * title and social metadata in the served HTML for crawlers and link previews,
 * while handing the same values to React so it renders them without a
 * round-trip. See src/client/index.html.
 */
export function renderPage(template: string, cfg: Config): string {
  const bootstrap: AppBootstrap = { title: cfg.streamTitle, tagline: cfg.streamTagline }
  return template
    .replaceAll('{{TITLE}}', escapeHtml(cfg.streamTitle))
    .replaceAll('{{TAGLINE}}', escapeHtml(cfg.streamTagline))
    .replaceAll('{{BOOTSTRAP}}', escapeJsonForScript(JSON.stringify(bootstrap)))
}

/**
 * Presence beacons (navigator.sendBeacon) and keepalive fetches can arrive with
 * a Content-Type Fastify's built-in parsers reject (form-urlencoded,
 * octet-stream) or none at all, which would 415. Those endpoints only need the
 * id from the query or a JSON body, so parse leniently rather than rejecting.
 */
function parseJsonish(
  _req: unknown,
  body: string,
  done: (err: Error | null, value?: unknown) => void,
): void {
  if (!body) return done(null, {})
  try {
    done(null, JSON.parse(body))
  } catch {
    done(null, {})
  }
}

/** Presence ids are client-generated, so bound them before they hit the map. */
function isValidId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id.length <= 64
}

export async function buildServer(
  cfg: Config,
  options: ServerOptions = {},
): Promise<FastifyInstance> {
  const { getDetections, clientDir = DEFAULT_CLIENT_DIR } = options
  const app = Fastify({ logger: { level: cfg.logLevel }, trustProxy: true })

  app.addContentTypeParser('text/plain', { parseAs: 'string' }, parseJsonish)
  app.addContentTypeParser('*', { parseAs: 'string' }, parseJsonish)

  // Vite content-hashes every filename under assets/, so a given URL's bytes
  // never change — cache it forever. index.html (below) is the one mutable
  // entry point and stays no-cache, which is what makes a deploy take effect.
  // @fastify/static v10 hands `setHeaders` the Fastify reply, not the raw
  // ServerResponse — hence `reply.header()` rather than `res.setHeader()`.
  await app.register(fastifyStatic, {
    root: path.join(clientDir, 'assets'),
    prefix: '/assets/',
    cacheControl: false,
    setHeaders: (reply) => {
      reply.header('Cache-Control', 'public, max-age=31536000, immutable')
    },
  })

  // Live HLS output. Segments get immutable long-cache (unique filenames);
  // the playlist is handled by the explicit route further down.
  await app.register(fastifyStatic, {
    root: cfg.hlsDir,
    prefix: '/hls/',
    decorateReply: false,
    cacheControl: false,
    setHeaders: (reply, filePath) => {
      if (filePath.endsWith('.m3u8')) {
        reply.header('Content-Type', 'application/vnd.apple.mpegurl')
        reply.header('Cache-Control', 'public, max-age=1')
      } else if (filePath.endsWith('.ts')) {
        reply.header('Content-Type', 'video/mp2t')
        reply.header('Cache-Control', 'public, max-age=31536000, immutable')
      }
    },
  })

  // Landing page, rendered once at boot with the configured title/tagline.
  const indexPath = path.join(clientDir, 'index.html')
  let template: string
  try {
    template = await readFile(indexPath, 'utf8')
  } catch {
    throw new Error(`Client build not found at ${indexPath} — run \`npm run build\` first.`)
  }
  const page = renderPage(template, cfg)

  app.get('/', async (_req, reply) => {
    reply.header('Content-Type', 'text/html; charset=utf-8')
    reply.header('Cache-Control', 'no-cache')
    return reply.send(page)
  })

  // Serve the live playlist with a spec-compliant TARGETDURATION. With -c copy
  // we can only cut on camera keyframes, so segments run slightly over the
  // rounded target (e.g. 4.04s vs TARGETDURATION:4) — which iOS's strict native
  // HLS player rejects, causing constant "reconnecting". Segments are untouched;
  // we just raise the declared target to ceil(longest segment). This exact route
  // takes precedence over the /hls/* static handler for the playlist only.
  app.get('/hls/stream.m3u8', async (_req, reply) => {
    let text: string
    try {
      text = await readFile(path.join(cfg.hlsDir, 'stream.m3u8'), 'utf8')
    } catch {
      return reply.code(404).header('Cache-Control', 'no-store').send('playlist not ready\n')
    }
    const durations = [...text.matchAll(/#EXTINF:([\d.]+)/g)].map((m) => parseFloat(m[1] ?? '0'))
    if (durations.length > 0) {
      const compliant = Math.ceil(Math.max(...durations))
      text = text.replace(/#EXT-X-TARGETDURATION:\d+/, `#EXT-X-TARGETDURATION:${compliant}`)
    }
    reply.header('Content-Type', 'application/vnd.apple.mpegurl')
    // NEVER cache the live playlist. Even a couple of seconds of edge/browser
    // staleness can leave the player without the newest segment, so it drains
    // its buffer and stalls ("plays ~15s then reconnecting"). It's tiny anyway;
    // the bandwidth win is the immutable segments/images, which ARE cached.
    reply.header('Cache-Control', 'no-store')
    return reply.send(text)
  })

  // Live viewer counter. Heartbeats/leaves are POSTs (never CDN-cached) and
  // marked no-store; the count is held in memory with a TTL. See presence.ts.
  // TTL is ~2.5x the client heartbeat interval (20s) so a missed beat is fine.
  const presence = new Presence(50000)

  app.post('/api/heartbeat', async (req, reply) => {
    reply.header('Cache-Control', 'no-store')
    const id = (req.body as { id?: unknown } | undefined)?.id
    if (!isValidId(id)) return reply.code(400).send({ error: 'invalid id' })
    return reply.send({ viewers: presence.heartbeat(id) })
  })

  app.post('/api/leave', async (req, reply) => {
    reply.header('Cache-Control', 'no-store')
    const id = (req.query as { id?: unknown }).id // sent via navigator.sendBeacon
    if (isValidId(id)) presence.leave(id)
    return reply.send({ ok: true })
  })

  // Frigate detections: the last few snapshots per animal. Populated only when
  // MQTT is configured; otherwise these return an empty list / 404.
  const knownLabels = new Set(cfg.frigate.labels)

  app.get('/api/detections', async (_req, reply) => {
    // Tiny JSON, polled every 30s — keep it fresh (not cached) so new sightings
    // appear promptly. The heavy part, the snapshot images, IS edge-cached.
    reply.header('Cache-Control', 'no-store')
    const items: DetectionDto[] = (getDetections?.()?.list() ?? []).map((s) => ({
      id: s.id,
      label: s.label,
      camera: s.camera,
      seenAt: s.seenAt,
      score: s.score || null,
      image: `/api/detections/${encodeURIComponent(s.label)}/${s.hash}/snapshot.jpg`,
    }))
    return reply.send({ detections: items })
  })

  app.get('/api/detections/:label/:hash/snapshot.jpg', async (req, reply) => {
    const params = req.params as { label: string; hash: string }
    const label = String(params.label).toLowerCase()
    if (!knownLabels.has(label)) return reply.code(404).send('unknown label')

    // Reject anything that isn't hash-shaped before touching the store.
    const hash = String(params.hash)
    if (!SNAPSHOT_HASH_PATTERN.test(hash)) return reply.code(404).send('bad snapshot hash')

    const image = getDetections?.()?.getImage(label, hash)
    if (!image) return reply.code(404).send('no such snapshot')
    reply.header('Content-Type', 'image/jpeg')
    // The URL is content-addressed, so it can only ever name these exact bytes
    // — safe to cache forever even across restarts and redeploys. It also lives
    // entirely in the path, so it survives a CDN configured to strip query
    // strings from the cache key.
    reply.header('Cache-Control', 'public, max-age=31536000, immutable')
    return reply.send(image)
  })

  const staleMs = Math.max(15000, cfg.hlsSegmentTime * 1000 * 5)
  app.get('/healthz', async (_req, reply) => {
    const playlist = path.join(cfg.hlsDir, 'stream.m3u8')
    try {
      const stats = await stat(playlist)
      const ageMs = Date.now() - stats.mtimeMs
      if (ageMs > staleMs) return reply.code(503).send({ status: 'stale', ageMs })
      return reply.send({ status: 'ok', ageMs })
    } catch {
      return reply.code(503).send({ status: 'starting' })
    }
  })

  return app
}
