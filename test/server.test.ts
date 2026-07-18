import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import type { Config } from '../src/config.js';

function makeCfg(hlsDir: string): Config {
  return {
    port: 0,
    rtspUrl: 'rtsp://host/1',
    rtspTransport: 'tcp',
    tunnelToken: 't',
    tunnelProtocol: 'http2',
    hlsDir,
    hlsSegmentTime: 2,
    hlsListSize: 6,
    enableAudio: false,
    streamTitle: "Paul's Chickens",
    streamTagline: 'Live from the coop',
    logLevel: 'silent',
    ffmpegExtraArgs: [],
  };
}

describe('server routes', () => {
  let dir: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'cluckcam-test-'));
    app = await buildServer(makeCfg(dir));
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('serves the templated landing page with the configured title', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers['content-type']), /text\/html/);
    assert.match(res.body, /Paul(&#39;|')s Chickens/);
  });

  it('/healthz is 503 with no playlist and 200 once one exists', async () => {
    const first = await app.inject({ method: 'GET', url: '/healthz' });
    assert.equal(first.statusCode, 503);

    await writeFile(path.join(dir, 'stream.m3u8'), '#EXTM3U\n#EXTINF:4.0,\nseg_0.ts\n');
    const second = await app.inject({ method: 'GET', url: '/healthz' });
    assert.equal(second.statusCode, 200);
  });

  it('rewrites TARGETDURATION up so iOS accepts it (>= longest segment)', async () => {
    // iOS-hostile playlist: declares 4 but ships a 4.04s segment.
    await writeFile(
      path.join(dir, 'stream.m3u8'),
      '#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:4.040000,\nseg_0.ts\n',
    );
    const res = await app.inject({ method: 'GET', url: '/hls/stream.m3u8' });
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers['content-type']), /vnd\.apple\.mpegurl/);
    assert.equal(res.headers['cache-control'], 'no-cache');
    assert.match(res.body, /#EXT-X-TARGETDURATION:5/);
    assert.doesNotMatch(res.body, /#EXT-X-TARGETDURATION:4/);
  });

  it('serves .ts segments with an immutable long cache', async () => {
    await writeFile(path.join(dir, 'seg_0.ts'), 'fake');
    const res = await app.inject({ method: 'GET', url: '/hls/seg_0.ts' });
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers['content-type']), /mp2t/);
    assert.match(String(res.headers['cache-control']), /immutable/);
  });

  it('serves page assets with revalidate (no-cache) so rebuilds take effect', async () => {
    const res = await app.inject({ method: 'GET', url: '/assets/app.js' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['cache-control'], 'no-cache');
  });

  it('POST /api/heartbeat counts viewers, dedupes, and is no-store', async () => {
    const first = await app.inject({ method: 'POST', url: '/api/heartbeat', payload: { id: 'v1' } });
    assert.equal(first.statusCode, 200);
    assert.equal(first.headers['cache-control'], 'no-store');
    assert.equal(first.json().viewers, 1);

    const repeat = await app.inject({ method: 'POST', url: '/api/heartbeat', payload: { id: 'v1' } });
    assert.equal(repeat.json().viewers, 1); // same id => still one viewer

    const other = await app.inject({ method: 'POST', url: '/api/heartbeat', payload: { id: 'v2' } });
    assert.equal(other.json().viewers, 2);
  });

  it('rejects a heartbeat with a missing/invalid id', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/heartbeat', payload: {} });
    assert.equal(res.statusCode, 400);
  });

  it('POST /api/leave drops a session', async () => {
    await app.inject({ method: 'POST', url: '/api/heartbeat', payload: { id: 'a' } });
    await app.inject({ method: 'POST', url: '/api/heartbeat', payload: { id: 'b' } });
    await app.inject({ method: 'POST', url: '/api/leave?id=a' });
    const res = await app.inject({ method: 'POST', url: '/api/heartbeat', payload: { id: 'b' } });
    assert.equal(res.json().viewers, 1); // only b remains
  });
});
