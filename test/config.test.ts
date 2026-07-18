import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { expandEnv, redactRtsp, loadConfig } from '../src/config.js';

const SAVED = { ...process.env };
const APP_VARS = [
  'RTSP_URL', 'TUNNEL_TOKEN', 'PORT', 'HLS_DIR', 'HLS_SEGMENT_TIME', 'HLS_LIST_SIZE',
  'ENABLE_AUDIO', 'RTSP_TRANSPORT', 'TUNNEL_PROTOCOL', 'STREAM_TITLE', 'STREAM_TAGLINE',
  'LOG_LEVEL', 'FFMPEG_EXTRA_ARGS', 'CAM_USER', 'CAM_PASS', 'FOO', 'NOPE',
  'MQTT_HOST', 'MQTT_PORT', 'MQTT_USERNAME', 'MQTT_PASSWORD', 'MQTT_TLS',
  'MQTT_TOPIC_PREFIX', 'FRIGATE_CAMERA', 'FRIGATE_LABELS',
];

function resetEnv(): void {
  process.env = { ...SAVED };
  for (const key of APP_VARS) delete process.env[key];
}

describe('expandEnv', () => {
  beforeEach(resetEnv);
  afterEach(() => {
    process.env = { ...SAVED };
  });

  it('substitutes ${VAR} from the environment', () => {
    process.env.FOO = 'bar';
    assert.equal(expandEnv('x-${FOO}-y'), 'x-bar-y');
  });

  it('leaves strings without placeholders untouched', () => {
    assert.equal(expandEnv('rtsp://u:p@host/1?x=1&y=2'), 'rtsp://u:p@host/1?x=1&y=2');
  });

  it('throws when a referenced var is missing', () => {
    assert.throws(() => expandEnv('${NOPE}'), /NOPE/);
  });
});

describe('redactRtsp', () => {
  it('masks user and password', () => {
    assert.equal(redactRtsp('rtsp://user:pass@host:554/cam'), 'rtsp://***:***@host:554/cam');
  });

  it('leaves a credential-less URL alone', () => {
    assert.equal(redactRtsp('rtsp://host:554/cam'), 'rtsp://host:554/cam');
  });

  it('redacts credentials even with a query string', () => {
    const out = redactRtsp('rtsp://paul:secret@host:554/cam?a=1&b=2');
    assert.ok(!out.includes('paul'));
    assert.ok(!out.includes('secret'));
    assert.ok(out.includes('host:554'));
  });
});

describe('loadConfig', () => {
  beforeEach(resetEnv);
  afterEach(() => {
    process.env = { ...SAVED };
  });

  it('throws when RTSP_URL is missing', () => {
    process.env.TUNNEL_TOKEN = 't';
    assert.throws(() => loadConfig(), /RTSP_URL/);
  });

  it('throws when TUNNEL_TOKEN is missing', () => {
    process.env.RTSP_URL = 'rtsp://host/1';
    assert.throws(() => loadConfig(), /TUNNEL_TOKEN/);
  });

  it('rejects a non-rtsp URL', () => {
    process.env.RTSP_URL = 'http://host/1';
    process.env.TUNNEL_TOKEN = 't';
    assert.throws(() => loadConfig(), /rtsp/i);
  });

  it('applies sensible defaults', () => {
    process.env.RTSP_URL = 'rtsp://host:554/1';
    process.env.TUNNEL_TOKEN = 't';
    const cfg = loadConfig();
    assert.equal(cfg.port, 8080);
    assert.equal(cfg.rtspTransport, 'tcp');
    assert.equal(cfg.tunnelProtocol, 'http2'); // today's fix: firewall-friendly default
    assert.equal(cfg.enableAudio, false);
    assert.equal(cfg.hlsSegmentTime, 2);
    assert.ok(cfg.hlsDir.length > 0);
  });

  it('expands ${VAR} inside RTSP_URL', () => {
    process.env.CAM_USER = 'paul';
    process.env.CAM_PASS = 'sec';
    process.env.RTSP_URL = 'rtsp://${CAM_USER}:${CAM_PASS}@host:554/1';
    process.env.TUNNEL_TOKEN = 't';
    assert.equal(loadConfig().rtspUrl, 'rtsp://paul:sec@host:554/1');
  });

  it('parses booleans and numbers', () => {
    process.env.RTSP_URL = 'rtsp://host/1';
    process.env.TUNNEL_TOKEN = 't';
    process.env.ENABLE_AUDIO = 'true';
    process.env.PORT = '9000';
    process.env.HLS_LIST_SIZE = '12';
    const cfg = loadConfig();
    assert.equal(cfg.enableAudio, true);
    assert.equal(cfg.port, 9000);
    assert.equal(cfg.hlsListSize, 12);
  });

  it('leaves Frigate disabled unless MQTT_HOST is set', () => {
    process.env.RTSP_URL = 'rtsp://host/1';
    process.env.TUNNEL_TOKEN = 't';
    const cfg = loadConfig();
    assert.equal(cfg.frigate.enabled, false);
    assert.deepEqual(cfg.frigate.labels, [
      'bear', 'deer', 'dog', 'cat', 'bird', 'raccoon', 'fox', 'squirrel', 'rabbit', 'person',
    ]);
  });

  it('enables Frigate and parses MQTT settings when MQTT_HOST is set', () => {
    process.env.RTSP_URL = 'rtsp://host/1';
    process.env.TUNNEL_TOKEN = 't';
    process.env.MQTT_HOST = 'nvr.coia.io';
    process.env.MQTT_PORT = '1833';
    process.env.FRIGATE_CAMERA = 'roaming';
    process.env.FRIGATE_LABELS = 'Bear, Fox ,rabbit';
    const cfg = loadConfig();
    assert.equal(cfg.frigate.enabled, true);
    assert.equal(cfg.frigate.host, 'nvr.coia.io');
    assert.equal(cfg.frigate.port, 1833);
    assert.equal(cfg.frigate.camera, 'roaming');
    assert.deepEqual(cfg.frigate.labels, ['bear', 'fox', 'rabbit']); // trimmed + lowercased
  });
});
