/**
 * Frigate integration over MQTT. Subscribes to `<prefix>/events` for detection
 * metadata (label, camera, timestamp) and `<prefix>/<camera>/<label>/snapshot`
 * for the best JPEG of each detection, keeping the last few snapshots per label
 * in a small ring buffer.
 *
 * No disk, no HTTP calls to Frigate — everything rides the MQTT link. The store
 * is deliberately in-memory and starts empty on every boot: retained snapshots
 * the broker replays at subscribe time are ignored, so the page only ever shows
 * detections that happened while this process was running.
 */

import type { FastifyBaseLogger } from 'fastify'
import mqtt, { type MqttClient } from 'mqtt'
import { createHash } from 'node:crypto'
import type { FrigateSettings } from './config.js'

/** How many snapshots we keep per label before the oldest is evicted. */
export const MAX_SNAPSHOTS_PER_LABEL = 5

/** Hex characters of the content hash used in snapshot URLs. */
export const SNAPSHOT_HASH_LENGTH = 16

/**
 * Snapshot URLs are content-addressed, which is what makes the `immutable`
 * cache header on them honest.
 *
 * A per-process counter would not be: this history lives only in memory, so a
 * restart resets it and id 1 would be reissued to a different photo — while
 * every browser and CDN edge still holds the previous id 1 for a year. Hashing
 * the bytes means a URL can only ever refer to the image it was minted for.
 *
 * It also means a restart that re-ingests the same retained snapshots produces
 * the same URLs, so those edge cache entries stay warm instead of forcing the
 * origin to re-serve everything after each deploy.
 */
function snapshotHash(image: Buffer): string {
  return createHash('sha256').update(image).digest('hex').slice(0, SNAPSHOT_HASH_LENGTH)
}

/**
 * A snapshot published close behind an event is almost certainly the same
 * sighting, so it inherits the event's (more accurate) frame time. Beyond this
 * the two are treated as unrelated and the arrival time is used instead.
 */
const EVENT_PAIRING_WINDOW_MS = 60_000

interface Snapshot {
  /** Content hash — the URL segment. See {@link snapshotHash}. */
  hash: string
  /**
   * Monotonic within this process. Used only to order snapshots taken at the
   * same instant and to key the client's list — never in a cacheable URL, so
   * it is safe for this to restart from 1.
   */
  seq: number
  image: Buffer
  /** Epoch ms the animal was seen. Always a real time — see ingestSnapshot. */
  seenAt: number
}

/** Per-label state: the animal's metadata plus its snapshot ring buffer. */
interface Detection {
  label: string
  camera: string
  /** Epoch ms of the most recent `frigate/events` message for this label. */
  lastEventAt: number
  score: number
  /** Oldest first, capped at {@link MAX_SNAPSHOTS_PER_LABEL}. */
  snapshots: Snapshot[]
}

/** One stored snapshot, flattened with the animal's metadata. */
export interface Sighting {
  /** Process-local; identifies the sighting in the JSON, not in a URL. */
  id: number
  /** Content hash, used to build the snapshot's immutable URL. */
  hash: string
  label: string
  camera: string
  score: number
  /** Epoch ms the animal was seen. */
  seenAt: number
  image: Buffer
}

/** The read side the HTTP server needs — lets tests inject a stub. */
export interface DetectionSource {
  /** Every stored snapshot, newest first; undated ones last. */
  list(): Sighting[]
  getImage(label: string, hash: string): Buffer | undefined
}

export class FrigateEvents implements DetectionSource {
  private client: MqttClient | null = null
  private readonly store = new Map<string, Detection>()
  private readonly labels: Set<string>
  private readonly eventsTopic: string
  /** Orders snapshots and keys the client's list; not part of any URL. */
  private nextSeq = 1

  constructor(
    private readonly cfg: FrigateSettings,
    private readonly log: FastifyBaseLogger,
  ) {
    this.labels = new Set(cfg.labels)
    this.eventsTopic = `${cfg.topicPrefix}/events`
  }

  start(): void {
    const url = `${this.cfg.tls ? 'mqtts' : 'mqtt'}://${this.cfg.host}:${this.cfg.port}`
    this.log.info(`frigate: connecting to ${url}`)
    this.client = mqtt.connect(url, {
      username: this.cfg.username,
      password: this.cfg.password,
      reconnectPeriod: 5000,
      connectTimeout: 15000,
      clientId: `cluckcam_${Math.random().toString(16).slice(2, 10)}`,
    })

    const snapshotsTopic = `${this.cfg.topicPrefix}/+/+/snapshot`
    this.client.on('connect', () => {
      this.log.info('frigate: mqtt connected')
      this.client?.subscribe([this.eventsTopic, snapshotsTopic], (err) => {
        if (err) this.log.warn(`frigate: subscribe failed: ${err.message}`)
      })
    })
    this.client.on('reconnect', () => this.log.debug('frigate: reconnecting'))
    this.client.on('error', (err) => this.log.warn(`frigate: mqtt error: ${err.message}`))
    this.client.on('message', (topic, payload, packet) => {
      if (topic === this.eventsTopic) this.ingestEvent(payload)
      else if (topic.endsWith('/snapshot')) this.ingestSnapshot(topic, payload, packet.retain)
    })
  }

  /** Parse a `frigate/events` payload and update per-label metadata. */
  ingestEvent(payload: Buffer): void {
    let after: Record<string, unknown> | undefined
    try {
      after = (JSON.parse(payload.toString('utf8')) as { after?: Record<string, unknown> }).after
    } catch {
      return
    }
    if (!after) return

    const label = typeof after.label === 'string' ? after.label.toLowerCase() : ''
    if (!this.labels.has(label)) return
    const camera = typeof after.camera === 'string' ? after.camera : ''
    if (this.cfg.camera && camera !== this.cfg.camera) return
    if (after.false_positive === true) return

    const seconds =
      typeof after.frame_time === 'number'
        ? after.frame_time
        : typeof after.start_time === 'number'
          ? after.start_time
          : undefined
    const ts = seconds !== undefined ? seconds * 1000 : Date.now()
    const score = typeof after.score === 'number' ? after.score : Number(after.top_score) || 0

    const rec = this.record(label, camera)
    if (ts >= rec.lastEventAt) {
      rec.lastEventAt = ts
      if (score) rec.score = score
      if (camera) rec.camera = camera
    }
    this.store.set(label, rec)
  }

  /**
   * Store the JPEG from a `<prefix>/<camera>/<label>/snapshot` message.
   *
   * `retained` messages are dropped: the broker replays the last snapshot per
   * topic the moment we subscribe, and those images can be days old with no
   * timestamp attached. Keeping them would mean every restart repopulating the
   * page with stale history, so the grid starts empty and fills from live
   * detections only.
   *
   * This does *not* drop real detections even though Frigate publishes
   * snapshots with `retain=1`: MQTT requires the broker to clear the flag when
   * forwarding to an already-established subscription, so `retained` is true
   * only for the replay-at-subscribe. (MQTT 5's "Retain As Published" would
   * change that; mqtt.js leaves it off, and we connect as 3.1.1.)
   */
  ingestSnapshot(topic: string, payload: Buffer, retained: boolean): void {
    if (retained) return

    const parts = topic.split('/')
    const camera = parts[parts.length - 3] ?? ''
    const label = (parts[parts.length - 2] ?? '').toLowerCase()
    if (!this.labels.has(label)) return
    if (this.cfg.camera && camera !== this.cfg.camera) return
    if (payload.length === 0) return

    const rec = this.record(label, camera)
    if (!rec.camera && camera) rec.camera = camera

    // Frigate can republish an unchanged image; without this the ring buffer
    // would fill with copies of the same picture.
    const hash = snapshotHash(payload)
    if (rec.snapshots.some((s) => s.hash === hash)) return

    rec.snapshots.push({
      hash,
      seq: this.nextSeq++,
      image: payload,
      seenAt: this.snapshotTime(rec),
    })
    // Ring buffer: once full, the oldest snapshot falls off the front.
    if (rec.snapshots.length > MAX_SNAPSHOTS_PER_LABEL) rec.snapshots.shift()

    this.store.set(label, rec)
  }

  /**
   * When a snapshot's animal was seen.
   *
   * A snapshot means a detection just ended, so it takes the matching event's
   * frame time (Frigate's own, more accurate figure) when one arrived recently,
   * else the arrival time.
   */
  private snapshotTime(rec: Detection): number {
    const now = Date.now()
    const pairsWithEvent = rec.lastEventAt > 0 && now - rec.lastEventAt < EVENT_PAIRING_WINDOW_MS
    return pairsWithEvent ? rec.lastEventAt : now
  }

  private record(label: string, camera: string): Detection {
    return this.store.get(label) ?? { label, camera, lastEventAt: 0, score: 0, snapshots: [] }
  }

  list(): Sighting[] {
    return (
      [...this.store.values()]
        .flatMap((d) =>
          d.snapshots.map((s) => ({
            id: s.seq,
            hash: s.hash,
            label: d.label,
            camera: d.camera,
            score: d.score,
            seenAt: s.seenAt,
            image: s.image,
          })),
        )
        // Newest first; seq breaks same-instant ties so the order is stable.
        .toSorted((a, b) => b.seenAt - a.seenAt || b.id - a.id)
    )
  }

  getImage(label: string, hash: string): Buffer | undefined {
    return this.store.get(label.toLowerCase())?.snapshots.find((s) => s.hash === hash)?.image
  }

  async stop(): Promise<void> {
    const client = this.client
    this.client = null
    if (!client) return
    await new Promise<void>((resolve) => client.end(false, {}, () => resolve()))
  }
}
