import type { FastifyInstance } from 'fastify'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AppBootstrap } from '../shared/types.js'
import { buildServer, renderPage } from './server.js'
import { makeCfg } from './test/fixtures.js'

/**
 * A stand-in for `dist/client`, so the route tests don't depend on having run
 * `vite build` first. It mirrors the real shape: a templated index.html plus a
 * content-hashed bundle under assets/.
 */
const TEMPLATE = [
  '<!doctype html><html><head><title>{{TITLE}}</title>',
  '<meta name="description" content="{{TAGLINE}}" />',
  '<script type="application/json" id="app-bootstrap">{{BOOTSTRAP}}</script>',
  '</head><body><div id="root"></div></body></html>',
].join('')

async function makeClientBuild(root: string): Promise<string> {
  const clientDir = path.join(root, 'client')
  await mkdir(path.join(clientDir, 'assets'), { recursive: true })
  await writeFile(path.join(clientDir, 'index.html'), TEMPLATE)
  await writeFile(path.join(clientDir, 'assets', 'index-abc123.js'), 'console.log(1);\n')
  return clientDir
}

/** Pulls the server-injected config back out of the rendered page. */
function bootstrapFrom(html: string): AppBootstrap {
  const match = /<script type="application\/json" id="app-bootstrap">([\S\s]*?)<\/script>/.exec(
    html,
  )
  if (!match?.[1]) throw new Error('rendered page has no bootstrap script')
  return JSON.parse(match[1]) as AppBootstrap
}

describe('renderPage', () => {
  it('HTML-escapes the title and tagline into the document head', () => {
    const html = renderPage(TEMPLATE, makeCfg({ streamTagline: 'Chickens & <friends>' }))
    expect(html).toContain('<title>Paul&#39;s Chickens</title>')
    expect(html).toContain('content="Chickens &amp; &lt;friends&gt;"')
  })

  it('hands the raw (unescaped) values to the client as JSON', () => {
    const html = renderPage(TEMPLATE, makeCfg({ streamTagline: 'Chickens & <friends>' }))
    expect(bootstrapFrom(html)).toEqual({
      title: "Paul's Chickens",
      tagline: 'Chickens & <friends>',
    })
  })

  it('a title containing </script> cannot break out of the bootstrap block', () => {
    const nasty = '</script><script>alert(1)</script>'
    const html = renderPage(TEMPLATE, makeCfg({ streamTitle: nasty }))

    // No second, attacker-controlled script element made it into the page...
    expect(html).not.toContain('<script>alert(1)</script>')
    // ...and the value still round-trips intact for the client.
    expect(bootstrapFrom(html).title).toBe(nasty)
  })

  it('leaves no unreplaced placeholders behind', () => {
    expect(renderPage(TEMPLATE, makeCfg())).not.toMatch(/\{\{[A-Z]+\}\}/)
  })
})

describe('server routes', () => {
  let root: string
  let app: FastifyInstance

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'cluckcam-test-'))
    const hlsDir = path.join(root, 'hls')
    await mkdir(hlsDir, { recursive: true })
    app = await buildServer(makeCfg({ hlsDir }), { clientDir: await makeClientBuild(root) })
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
    await rm(root, { recursive: true, force: true })
  })

  const hlsPath = (name: string) => path.join(root, 'hls', name)

  it('serves the templated landing page with the configured title', async () => {
    const res = await app.inject({ method: 'GET', url: '/' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toMatch(/text\/html/)
    expect(res.headers['cache-control']).toBe('no-cache') // the one mutable entry point
    expect(res.body).toContain('Paul&#39;s Chickens')
    expect(bootstrapFrom(res.body).tagline).toBe('Live from the coop')
  })

  it('/healthz is 503 with no playlist and 200 once one exists', async () => {
    const first = await app.inject({ method: 'GET', url: '/healthz' })
    expect(first.statusCode).toBe(503)

    await writeFile(hlsPath('stream.m3u8'), '#EXTM3U\n#EXTINF:4.0,\nseg_0.ts\n')
    const second = await app.inject({ method: 'GET', url: '/healthz' })
    expect(second.statusCode).toBe(200)
  })

  it('rewrites TARGETDURATION up so iOS accepts it (>= longest segment)', async () => {
    // iOS-hostile playlist: declares 4 but ships a 4.04s segment.
    await writeFile(
      hlsPath('stream.m3u8'),
      '#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:4.040000,\nseg_0.ts\n',
    )
    const res = await app.inject({ method: 'GET', url: '/hls/stream.m3u8' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toMatch(/vnd\.apple\.mpegurl/)
    expect(res.headers['cache-control']).toBe('no-store') // live playlist never cached
    expect(res.body).toContain('#EXT-X-TARGETDURATION:5')
    expect(res.body).not.toContain('#EXT-X-TARGETDURATION:4')
  })

  it('404s the playlist before ffmpeg has produced one', async () => {
    const res = await app.inject({ method: 'GET', url: '/hls/stream.m3u8' })
    expect(res.statusCode).toBe(404)
    expect(res.headers['cache-control']).toBe('no-store')
  })

  it('serves .ts segments with an immutable long cache', async () => {
    await writeFile(hlsPath('seg_0.ts'), 'fake')
    const res = await app.inject({ method: 'GET', url: '/hls/seg_0.ts' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toMatch(/mp2t/)
    expect(res.headers['cache-control']).toMatch(/immutable/)
  })

  it('serves hashed client bundles as immutable', async () => {
    const res = await app.inject({ method: 'GET', url: '/assets/index-abc123.js' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable')
  })

  it('POST /api/heartbeat counts viewers, dedupes, and is no-store', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/api/heartbeat',
      payload: { id: 'v1' },
    })
    expect(first.statusCode).toBe(200)
    expect(first.headers['cache-control']).toBe('no-store')
    expect(first.json().viewers).toBe(1)

    const repeat = await app.inject({
      method: 'POST',
      url: '/api/heartbeat',
      payload: { id: 'v1' },
    })
    expect(repeat.json().viewers).toBe(1) // same id => still one viewer

    const other = await app.inject({
      method: 'POST',
      url: '/api/heartbeat',
      payload: { id: 'v2' },
    })
    expect(other.json().viewers).toBe(2)
  })

  it('rejects a heartbeat with a missing/invalid id', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/heartbeat', payload: {} })
    expect(res.statusCode).toBe(400)
  })

  it('accepts presence POSTs with odd/absent Content-Type (no 415)', async () => {
    // A JSON body with no Content-Type header (fetch keepalive / iOS quirk).
    const noCt = await app.inject({
      method: 'POST',
      url: '/api/heartbeat',
      payload: '{"id":"beacon"}',
    })
    expect(noCt.statusCode).toBe(200)
    expect(noCt.json().viewers).toBe(1)

    // sendBeacon can send form-urlencoded / octet-stream — /api/leave reads the
    // query, so the body is irrelevant and must not 415.
    for (const ct of ['application/x-www-form-urlencoded', 'application/octet-stream']) {
      const leave = await app.inject({
        method: 'POST',
        url: '/api/leave?id=beacon',
        headers: { 'content-type': ct },
        payload: 'anything',
      })
      expect(leave.statusCode).toBe(200)
    }
  })

  it('POST /api/leave drops a session', async () => {
    await app.inject({ method: 'POST', url: '/api/heartbeat', payload: { id: 'a' } })
    await app.inject({ method: 'POST', url: '/api/heartbeat', payload: { id: 'b' } })
    await app.inject({ method: 'POST', url: '/api/leave?id=a' })
    const res = await app.inject({ method: 'POST', url: '/api/heartbeat', payload: { id: 'b' } })
    expect(res.json().viewers).toBe(1) // only b remains
  })

  it('detections list is empty and snapshots 404 with no source configured', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/detections' })
    expect(list.statusCode).toBe(200)
    expect(list.headers['cache-control']).toBe('no-store')
    expect(list.json().detections).toEqual([])

    const img = await app.inject({ method: 'GET', url: '/api/detections/deer/snapshot.jpg' })
    expect(img.statusCode).toBe(404)
  })
})

describe('buildServer without a client build', () => {
  it('fails loudly instead of serving a broken page', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'cluckcam-test-'))
    try {
      await expect(
        buildServer(makeCfg({ hlsDir: root }), { clientDir: path.join(root, 'missing') }),
      ).rejects.toThrow(/Client build not found/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('detection routes with a source', () => {
  let root: string
  let app: FastifyInstance
  const jpeg = Buffer.from('JPEGDATA')
  const source = {
    list: () => [
      {
        label: 'deer',
        camera: 'roaming',
        lastSeen: 1700000000000,
        score: 0.9,
        image: jpeg,
        imageAt: 42,
      },
    ],
    getImage: (label: string) => (label === 'deer' ? jpeg : undefined),
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'cluckcam-test-'))
    app = await buildServer(makeCfg({ hlsDir: root }), {
      clientDir: await makeClientBuild(root),
      getDetections: () => source,
    })
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
    await rm(root, { recursive: true, force: true })
  })

  it('lists detections with a cache-busting image URL', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/detections' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.detections).toHaveLength(1)
    expect(body.detections[0].label).toBe('deer')
    expect(body.detections[0].image).toBe('/api/detections/deer/snapshot.jpg?ts=42')
  })

  it('serves the snapshot image for a known label', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/detections/deer/snapshot.jpg' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toMatch(/image\/jpeg/)
    expect(res.headers['cache-control']).toMatch(/immutable/)
    expect(res.rawPayload.toString()).toBe('JPEGDATA')
  })

  it('404s an unknown label and a label with no image yet', async () => {
    const unknown = await app.inject({ method: 'GET', url: '/api/detections/person/snapshot.jpg' })
    expect(unknown.statusCode).toBe(404) // not in the configured label set

    const noImage = await app.inject({ method: 'GET', url: '/api/detections/bear/snapshot.jpg' })
    expect(noImage.statusCode).toBe(404) // known label, but source has no image
  })
})
