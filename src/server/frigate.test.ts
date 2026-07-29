import type { FastifyBaseLogger } from 'fastify'
import { describe, expect, it } from 'vitest'
import type { FrigateSettings } from './config.js'
import { FrigateEvents } from './frigate.js'

// FrigateEvents only touches the logger in start(); the ingest methods don't,
// so a no-op stub is enough for these unit tests.
const noopLog = {
  info() {},
  warn() {},
  debug() {},
  error() {},
  child() {
    return noopLog
  },
} as unknown as FastifyBaseLogger

const SETTINGS: FrigateSettings = {
  enabled: true,
  host: 'x',
  port: 1883,
  tls: false,
  topicPrefix: 'frigate',
  labels: ['bear', 'deer', 'dog', 'cat', 'bird', 'raccoon', 'fox', 'squirrel', 'rabbit'],
}

function event(label: string, extra: Record<string, unknown> = {}): Buffer {
  return Buffer.from(
    JSON.stringify({
      type: 'end',
      after: {
        label,
        camera: 'roaming',
        start_time: 1700000000,
        frame_time: 1700000005,
        score: 0.9,
        ...extra,
      },
    }),
  )
}

describe('FrigateEvents', () => {
  it('surfaces a target detection once it has an event and a snapshot', () => {
    const f = new FrigateEvents(SETTINGS, noopLog)
    f.ingestEvent(event('deer'))
    expect(f.list()).toHaveLength(0) // metadata only, no image yet

    f.ingestSnapshot('frigate/roaming/deer/snapshot', Buffer.from('jpeg'), false)
    const list = f.list()
    expect(list).toHaveLength(1)
    expect(list[0]?.label).toBe('deer')
    expect(list[0]?.lastSeen).toBe(1700000005 * 1000)
    expect(f.getImage('deer')).toBeDefined()
  })

  it('ignores labels outside the configured set', () => {
    const f = new FrigateEvents(SETTINGS, noopLog)
    f.ingestEvent(event('person'))
    f.ingestSnapshot('frigate/roaming/person/snapshot', Buffer.from('x'), false)
    expect(f.list()).toHaveLength(0)
    expect(f.getImage('person')).toBeUndefined()
  })

  it('ignores false positives', () => {
    const f = new FrigateEvents(SETTINGS, noopLog)
    f.ingestEvent(event('bear', { false_positive: true }))
    f.ingestSnapshot('frigate/roaming/bear/snapshot', Buffer.from('x'), false)
    // The snapshot still stores the image, but no valid event set a time.
    expect(f.list()[0]?.lastSeen).toBe(f.list()[0]?.imageAt)
  })

  it('filters by camera when configured', () => {
    const f = new FrigateEvents({ ...SETTINGS, camera: 'roaming' }, noopLog)
    f.ingestEvent(event('fox', { camera: 'driveway' }))
    f.ingestSnapshot('frigate/driveway/fox/snapshot', Buffer.from('x'), false)
    expect(f.list()).toHaveLength(0)

    f.ingestEvent(event('fox', { camera: 'roaming' }))
    f.ingestSnapshot('frigate/roaming/fox/snapshot', Buffer.from('x'), false)
    expect(f.list()).toHaveLength(1)
  })

  it('sorts most-recent first and ignores empty snapshot payloads', () => {
    const f = new FrigateEvents(SETTINGS, noopLog)
    f.ingestEvent(event('cat', { frame_time: 1700000001 }))
    f.ingestSnapshot('frigate/roaming/cat/snapshot', Buffer.from('c'), false)
    f.ingestEvent(event('dog', { frame_time: 1700000100 }))
    f.ingestSnapshot('frigate/roaming/dog/snapshot', Buffer.from('d'), false)
    f.ingestSnapshot('frigate/roaming/dog/snapshot', Buffer.alloc(0), false) // empty -> ignored

    const list = f.list()
    expect(list[0]?.label).toBe('dog') // newer frame_time
    expect(list[1]?.label).toBe('cat')
    expect(f.getImage('dog')?.toString()).toBe('d') // kept the real image
  })

  it('ranks undated retained snapshots below every dated sighting', () => {
    // The UI captions undated snapshots "seen earlier" (see lib/time.ts), so
    // they must not outrank a real, recent sighting in the grid.
    const f = new FrigateEvents(SETTINGS, noopLog)
    f.ingestSnapshot('frigate/roaming/raccoon/snapshot', Buffer.from('r'), true) // retained
    f.ingestSnapshot('frigate/roaming/bear/snapshot', Buffer.from('b'), true) // retained
    f.ingestEvent(event('deer', { frame_time: 1700000500 }))
    f.ingestSnapshot('frigate/roaming/deer/snapshot', Buffer.from('d'), false)

    const list = f.list()
    expect(list[0]?.label).toBe('deer')
    expect(list[0]?.lastSeen).toBeGreaterThan(0)
    expect(list.slice(1).map((d) => d.lastSeen)).toEqual([0, 0])
  })

  it('does not fabricate a timestamp from a retained snapshot', () => {
    const f = new FrigateEvents(SETTINGS, noopLog)
    f.ingestSnapshot('frigate/roaming/raccoon/snapshot', Buffer.from('r'), true) // retained
    const list = f.list()
    expect(list).toHaveLength(1)
    expect(list[0]?.lastSeen).toBe(0) // unknown time -> "recently" in the UI
  })

  it('ignores malformed event JSON', () => {
    const f = new FrigateEvents(SETTINGS, noopLog)
    f.ingestEvent(Buffer.from('not json'))
    expect(f.list()).toHaveLength(0)
  })
})
