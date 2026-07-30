import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { expandEnv, loadConfig, redactRtsp } from './config.js'

const SAVED = { ...process.env }
const APP_VARS = [
  'RTSP_URL',
  'PORT',
  'HLS_DIR',
  'HLS_SEGMENT_TIME',
  'HLS_LIST_SIZE',
  'ENABLE_AUDIO',
  'RTSP_TRANSPORT',
  'STREAM_TITLE',
  'STREAM_TAGLINE',
  'LOG_LEVEL',
  'FFMPEG_EXTRA_ARGS',
  'CAM_USER',
  'CAM_PASS',
  'FOO',
  'NOPE',
  'MQTT_HOST',
  'MQTT_PORT',
  'MQTT_USERNAME',
  'MQTT_PASSWORD',
  'MQTT_TLS',
  'MQTT_TOPIC_PREFIX',
  'FRIGATE_CAMERA',
  'FRIGATE_LABELS',
]

function resetEnv(): void {
  process.env = { ...SAVED }
  for (const key of APP_VARS) delete process.env[key]
}

beforeEach(resetEnv)
afterEach(() => {
  process.env = { ...SAVED }
})

describe('expandEnv', () => {
  it('substitutes ${VAR} from the environment', () => {
    process.env.FOO = 'bar'
    expect(expandEnv('x-${FOO}-y')).toBe('x-bar-y')
  })

  it('leaves strings without placeholders untouched', () => {
    expect(expandEnv('rtsp://u:p@host/1?x=1&y=2')).toBe('rtsp://u:p@host/1?x=1&y=2')
  })

  it('throws when a referenced var is missing', () => {
    expect(() => expandEnv('${NOPE}')).toThrow(/NOPE/)
  })
})

describe('redactRtsp', () => {
  it('masks user and password', () => {
    expect(redactRtsp('rtsp://user:pass@host:554/cam')).toBe('rtsp://***:***@host:554/cam')
  })

  it('leaves a credential-less URL alone', () => {
    expect(redactRtsp('rtsp://host:554/cam')).toBe('rtsp://host:554/cam')
  })

  it('redacts credentials even with a query string', () => {
    const out = redactRtsp('rtsp://paul:secret@host:554/cam?a=1&b=2')
    expect(out).not.toContain('paul')
    expect(out).not.toContain('secret')
    expect(out).toContain('host:554')
  })
})

describe('loadConfig', () => {
  it('throws when RTSP_URL is missing', () => {
    expect(() => loadConfig()).toThrow(/RTSP_URL/)
  })

  it('rejects a non-rtsp URL', () => {
    process.env.RTSP_URL = 'http://host/1'
    expect(() => loadConfig()).toThrow(/rtsp/i)
  })

  it('applies sensible defaults', () => {
    process.env.RTSP_URL = 'rtsp://host:554/1'
    const cfg = loadConfig()
    expect(cfg.port).toBe(8080)
    expect(cfg.rtspTransport).toBe('tcp')
    expect(cfg.enableAudio).toBe(false)
    expect(cfg.hlsSegmentTime).toBe(2)
    expect(cfg.hlsDir.length).toBeGreaterThan(0)
  })

  it('expands ${VAR} inside RTSP_URL', () => {
    process.env.CAM_USER = 'paul'
    process.env.CAM_PASS = 'sec'
    process.env.RTSP_URL = 'rtsp://${CAM_USER}:${CAM_PASS}@host:554/1'
    expect(loadConfig().rtspUrl).toBe('rtsp://paul:sec@host:554/1')
  })

  it('parses booleans and numbers', () => {
    process.env.RTSP_URL = 'rtsp://host/1'
    process.env.ENABLE_AUDIO = 'true'
    process.env.PORT = '9000'
    process.env.HLS_LIST_SIZE = '12'
    const cfg = loadConfig()
    expect(cfg.enableAudio).toBe(true)
    expect(cfg.port).toBe(9000)
    expect(cfg.hlsListSize).toBe(12)
  })

  it('leaves Frigate disabled unless MQTT_HOST is set', () => {
    process.env.RTSP_URL = 'rtsp://host/1'
    const cfg = loadConfig()
    expect(cfg.frigate.enabled).toBe(false)
    expect(cfg.frigate.labels).toEqual([
      'bear',
      'deer',
      'dog',
      'cat',
      'bird',
      'raccoon',
      'fox',
      'squirrel',
      'rabbit',
      'person',
    ])
  })

  it('enables Frigate and parses MQTT settings when MQTT_HOST is set', () => {
    process.env.RTSP_URL = 'rtsp://host/1'
    process.env.MQTT_HOST = 'nvr.coia.io'
    process.env.MQTT_PORT = '1833'
    process.env.FRIGATE_CAMERA = 'roaming'
    process.env.FRIGATE_LABELS = 'Bear, Fox ,rabbit'
    const cfg = loadConfig()
    expect(cfg.frigate.enabled).toBe(true)
    expect(cfg.frigate.host).toBe('nvr.coia.io')
    expect(cfg.frigate.port).toBe(1833)
    expect(cfg.frigate.camera).toBe('roaming')
    expect(cfg.frigate.labels).toEqual(['bear', 'fox', 'rabbit']) // trimmed + lowercased
  })
})
