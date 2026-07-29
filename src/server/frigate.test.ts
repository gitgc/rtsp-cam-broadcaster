import type { FastifyBaseLogger } from 'fastify'
import { describe, expect, it } from 'vitest'
import type { FrigateSettings } from './config.js'
import { FrigateEvents, MAX_SNAPSHOTS_PER_LABEL, SNAPSHOT_HASH_LENGTH } from './frigate.js'

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

interface EventOptions extends Record<string, unknown> {
  /** How long ago the frame was captured. Real events are seconds old. */
  agoMs?: number
}

/** A `frigate/events` payload. Frigate publishes `frame_time` in seconds. */
function event(label: string, { agoMs = 1_000, ...extra }: EventOptions = {}): Buffer {
  const frameTime = (Date.now() - agoMs) / 1000
  return Buffer.from(
    JSON.stringify({
      type: 'end',
      after: {
        label,
        camera: 'roaming',
        start_time: frameTime - 5,
        frame_time: frameTime,
        score: 0.9,
        ...extra,
      },
    }),
  )
}

const snapshot = (f: FrigateEvents, label: string, body: string, retained = false) =>
  f.ingestSnapshot(`frigate/roaming/${label}/snapshot`, Buffer.from(body), retained)

/** The stored images for one label, newest first. */
const imagesFor = (f: FrigateEvents, label: string) =>
  f
    .list()
    .filter((s) => s.label === label)
    .map((s) => s.image.toString())

describe('FrigateEvents', () => {
  it('surfaces a target detection once it has an event and a snapshot', () => {
    const f = new FrigateEvents(SETTINGS, noopLog)
    f.ingestEvent(event('deer'))
    expect(f.list()).toHaveLength(0) // metadata only, no image yet

    snapshot(f, 'deer', 'jpeg')
    const list = f.list()
    expect(list).toHaveLength(1)
    expect(list[0]?.label).toBe('deer')
    expect(f.getImage('deer', list[0]!.hash)?.toString()).toBe('jpeg')
  })

  it('ignores labels outside the configured set', () => {
    const f = new FrigateEvents(SETTINGS, noopLog)
    f.ingestEvent(event('person'))
    snapshot(f, 'person', 'x')
    expect(f.list()).toHaveLength(0)
    expect(f.getImage('person', 'deadbeefdeadbeef')).toBeUndefined()
  })

  it('ignores false positives but still stores the image', () => {
    const before = Date.now()
    const f = new FrigateEvents(SETTINGS, noopLog)
    f.ingestEvent(event('bear', { false_positive: true }))
    snapshot(f, 'bear', 'x')

    // No valid event set a time, so the snapshot is dated by its arrival.
    expect(f.list()[0]?.seenAt).toBeGreaterThanOrEqual(before)
  })

  it('filters by camera when configured', () => {
    const f = new FrigateEvents({ ...SETTINGS, camera: 'roaming' }, noopLog)
    f.ingestEvent(event('fox', { camera: 'driveway' }))
    f.ingestSnapshot('frigate/driveway/fox/snapshot', Buffer.from('x'), false)
    expect(f.list()).toHaveLength(0)

    f.ingestEvent(event('fox', { camera: 'roaming' }))
    snapshot(f, 'fox', 'y')
    expect(f.list()).toHaveLength(1)
  })

  it('ignores empty snapshot payloads', () => {
    const f = new FrigateEvents(SETTINGS, noopLog)
    snapshot(f, 'dog', 'd')
    snapshot(f, 'dog', '')
    expect(imagesFor(f, 'dog')).toEqual(['d'])
  })

  it('ignores malformed event JSON', () => {
    const f = new FrigateEvents(SETTINGS, noopLog)
    f.ingestEvent(Buffer.from('not json'))
    expect(f.list()).toHaveLength(0)
  })
})

describe('FrigateEvents starts empty on every boot', () => {
  /** What the broker replays the instant we subscribe. */
  const replayRetained = (f: FrigateEvents) => {
    for (const label of ['deer', 'fox', 'cat', 'bear']) snapshot(f, label, `old-${label}`, true)
  }

  it('ignores the retained snapshots the broker replays at subscribe time', () => {
    // These can be days old and carry no timestamp. Keeping them meant every
    // restart repopulating the page with stale history.
    const f = new FrigateEvents(SETTINGS, noopLog)
    replayRetained(f)

    expect(f.list()).toEqual([])
  })

  it('fills up from live detections after the replay', () => {
    const f = new FrigateEvents(SETTINGS, noopLog)
    replayRetained(f)
    expect(f.list()).toEqual([])

    f.ingestEvent(event('deer'))
    snapshot(f, 'deer', 'live-deer')

    expect(imagesFor(f, 'deer')).toEqual(['live-deer'])
  })

  it('still stores a live snapshot whose bytes match a replayed one', () => {
    // The retained image is dropped without being remembered, so an identical
    // live detection later must not be mistaken for a duplicate.
    const f = new FrigateEvents(SETTINGS, noopLog)
    snapshot(f, 'deer', 'same-bytes', true)
    snapshot(f, 'deer', 'same-bytes')

    expect(imagesFor(f, 'deer')).toEqual(['same-bytes'])
  })

  it('drops the replay again after an MQTT reconnect mid-session', () => {
    // Reconnects happen; they must not inject history alongside live sightings.
    const f = new FrigateEvents(SETTINGS, noopLog)
    f.ingestEvent(event('deer'))
    snapshot(f, 'deer', 'live-deer')

    replayRetained(f) // the broker replays on re-subscribe

    expect(f.list().map((s) => s.image.toString())).toEqual(['live-deer'])
  })
})

describe('FrigateEvents snapshot history', () => {
  it(`keeps up to ${MAX_SNAPSHOTS_PER_LABEL} snapshots for one label`, () => {
    const f = new FrigateEvents(SETTINGS, noopLog)
    for (const body of ['a', 'b', 'c', 'd', 'e']) snapshot(f, 'deer', body)

    expect(f.list()).toHaveLength(MAX_SNAPSHOTS_PER_LABEL)
    expect(imagesFor(f, 'deer').toSorted()).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('evicts the oldest once the ring is full', () => {
    const f = new FrigateEvents(SETTINGS, noopLog)
    for (const body of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) snapshot(f, 'deer', body)

    const stored = imagesFor(f, 'deer')
    expect(stored).toHaveLength(MAX_SNAPSHOTS_PER_LABEL)
    // 'a' and 'b' fell off the front; the five newest survive.
    expect(stored.toSorted()).toEqual(['c', 'd', 'e', 'f', 'g'])
  })

  it('stops serving an evicted snapshot', () => {
    const f = new FrigateEvents(SETTINGS, noopLog)
    snapshot(f, 'deer', 'oldest')
    const evicted = f.list()[0]!.hash
    expect(f.getImage('deer', evicted)?.toString()).toBe('oldest')

    for (const body of ['b', 'c', 'd', 'e', 'f']) snapshot(f, 'deer', body)

    expect(f.getImage('deer', evicted)).toBeUndefined()
  })

  it('keeps a separate ring per label', () => {
    const f = new FrigateEvents(SETTINGS, noopLog)
    for (const body of ['d1', 'd2', 'd3', 'd4', 'd5', 'd6']) snapshot(f, 'deer', body)
    for (const body of ['f1', 'f2']) snapshot(f, 'fox', body)

    // A busy deer must not crowd out the fox's history.
    expect(imagesFor(f, 'deer')).toHaveLength(MAX_SNAPSHOTS_PER_LABEL)
    expect(imagesFor(f, 'fox').toSorted()).toEqual(['f1', 'f2'])
    expect(f.list()).toHaveLength(MAX_SNAPSHOTS_PER_LABEL + 2)
  })

  it('gives every sighting a distinct list key and a resolvable hash', () => {
    const f = new FrigateEvents(SETTINGS, noopLog)
    for (const body of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) snapshot(f, 'deer', body)
    for (const body of ['x', 'y']) snapshot(f, 'fox', body)

    const ids = f.list().map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length) // React keys must be unique

    for (const s of f.list()) {
      expect(s.hash).toMatch(new RegExp(`^[0-9a-f]{${SNAPSHOT_HASH_LENGTH}}$`))
      expect(f.getImage(s.label, s.hash)?.equals(s.image)).toBe(true)
    }
  })

  it('addresses snapshots by content, so a restart cannot poison a cached URL', () => {
    // Snapshot URLs are served `immutable, max-age=1y`. The history is in-memory
    // only, so a restart begins from an empty store — a per-process counter
    // would hand id 1 to a different photo while every CDN edge still holds the
    // previous id 1. Hashing the bytes is what makes that impossible.
    const first = new FrigateEvents(SETTINGS, noopLog)
    snapshot(first, 'deer', 'monday-deer')
    const before = first.list()[0]!

    const afterRestart = new FrigateEvents(SETTINGS, noopLog)
    snapshot(afterRestart, 'deer', 'friday-deer')
    const after = afterRestart.list()[0]!

    // Same list key across the restart — proving the id alone is unsafe...
    expect(after.id).toBe(before.id)
    // ...while the URL segment differs, because the bytes do.
    expect(after.hash).not.toBe(before.hash)
  })

  it('gives identical bytes the same URL in a later process', () => {
    // The happy consequence of content addressing: if the same image is ever
    // ingested again, its edge cache entry is still valid.
    const first = new FrigateEvents(SETTINGS, noopLog)
    snapshot(first, 'deer', 'same-deer')

    const later = new FrigateEvents(SETTINGS, noopLog)
    snapshot(later, 'deer', 'same-deer')

    expect(later.list()[0]!.hash).toBe(first.list()[0]!.hash)
  })

  it('ignores a republished duplicate image', () => {
    // Frigate can republish an unchanged image; without a guard the ring would
    // fill with copies of the same picture.
    const f = new FrigateEvents(SETTINGS, noopLog)
    snapshot(f, 'raccoon', 'same')
    snapshot(f, 'raccoon', 'same')
    snapshot(f, 'raccoon', 'same')

    expect(imagesFor(f, 'raccoon')).toEqual(['same'])
  })

  it('still accepts a genuinely new image after a duplicate', () => {
    const f = new FrigateEvents(SETTINGS, noopLog)
    snapshot(f, 'raccoon', 'first')
    snapshot(f, 'raccoon', 'first')
    snapshot(f, 'raccoon', 'second')

    expect(imagesFor(f, 'raccoon').toSorted()).toEqual(['first', 'second'])
  })
})

describe('FrigateEvents ordering and timing', () => {
  it('dates a live snapshot from the matching event, not its arrival', () => {
    const before = Date.now()
    const f = new FrigateEvents(SETTINGS, noopLog)
    f.ingestEvent(event('deer', { agoMs: 10_000 }))
    snapshot(f, 'deer', 'jpeg')

    // Frigate's frame_time is the real detection moment, ~10s in the past here.
    const seenAt = f.list()[0]!.seenAt
    expect(seenAt).toBeLessThan(before - 5_000)
    expect(seenAt).toBeGreaterThan(before - 15_000)
  })

  it('falls back to arrival time when no recent event explains the snapshot', () => {
    const f = new FrigateEvents(SETTINGS, noopLog)
    f.ingestEvent(event('deer', { agoMs: 10 * 60_000 })) // long outside the pairing window
    const before = Date.now()
    snapshot(f, 'deer', 'jpeg')

    // Dating a snapshot that just arrived with an hour-old event would be wrong.
    expect(f.list()[0]!.seenAt).toBeGreaterThanOrEqual(before)
  })

  it('dates every stored snapshot with a real time', () => {
    const before = Date.now()
    const f = new FrigateEvents(SETTINGS, noopLog)
    snapshot(f, 'raccoon', 'r')

    // There is no "unknown age" state any more: undated retained images are
    // dropped outright, so the client can rely on seenAt being a real time.
    expect(f.list()[0]!.seenAt).toBeGreaterThanOrEqual(before)
  })

  it('lists newest first across labels', () => {
    const f = new FrigateEvents(SETTINGS, noopLog)
    f.ingestEvent(event('cat', { agoMs: 30_000 }))
    snapshot(f, 'cat', 'c')
    f.ingestEvent(event('dog', { agoMs: 2_000 }))
    snapshot(f, 'dog', 'd')

    expect(f.list().map((s) => s.label)).toEqual(['dog', 'cat'])
  })

  it('orders same-instant snapshots newest-ingested first', () => {
    // All three pair with the same event, so they share a seenAt exactly; seq
    // breaks the tie so the order is stable rather than arbitrary.
    const f = new FrigateEvents(SETTINGS, noopLog)
    f.ingestEvent(event('deer', { agoMs: 2_000 }))
    for (const body of ['first', 'second', 'third']) snapshot(f, 'deer', body)

    expect(new Set(f.list().map((s) => s.seenAt)).size).toBe(1)
    expect(imagesFor(f, 'deer')).toEqual(['third', 'second', 'first'])
  })
})
