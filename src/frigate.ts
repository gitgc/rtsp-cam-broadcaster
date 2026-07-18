/**
 * Frigate integration over MQTT. Subscribes to `<prefix>/events` for detection
 * metadata (label, camera, timestamp) and `<prefix>/<camera>/<label>/snapshot`
 * for the best JPEG of the last detection, keeping the latest per label in
 * memory. No disk, no HTTP calls to Frigate — everything rides the MQTT link.
 */

import mqtt, { type MqttClient } from 'mqtt';
import type { FastifyBaseLogger } from 'fastify';
import type { FrigateSettings } from './config.js';

export interface Detection {
  label: string;
  camera: string;
  /** Epoch ms of the last sighting; 0 if only a retained (historical) image. */
  lastSeen: number;
  score: number;
  image?: Buffer;
  /** Epoch ms the current image was received (used for cache-busting). */
  imageAt?: number;
}

/** The read side the HTTP server needs — lets tests inject a stub. */
export interface DetectionSource {
  list(): Detection[];
  getImage(label: string): Buffer | undefined;
}

export class FrigateEvents implements DetectionSource {
  private client: MqttClient | null = null;
  private readonly store = new Map<string, Detection>();
  private readonly labels: Set<string>;
  private readonly eventsTopic: string;

  constructor(
    private readonly cfg: FrigateSettings,
    private readonly log: FastifyBaseLogger,
  ) {
    this.labels = new Set(cfg.labels);
    this.eventsTopic = `${cfg.topicPrefix}/events`;
  }

  start(): void {
    const url = `${this.cfg.tls ? 'mqtts' : 'mqtt'}://${this.cfg.host}:${this.cfg.port}`;
    this.log.info(`frigate: connecting to ${url}`);
    this.client = mqtt.connect(url, {
      username: this.cfg.username,
      password: this.cfg.password,
      reconnectPeriod: 5000,
      connectTimeout: 15000,
      clientId: `cluckcam_${Math.random().toString(16).slice(2, 10)}`,
    });

    const snapshotsTopic = `${this.cfg.topicPrefix}/+/+/snapshot`;
    this.client.on('connect', () => {
      this.log.info('frigate: mqtt connected');
      this.client?.subscribe([this.eventsTopic, snapshotsTopic], (err) => {
        if (err) this.log.warn(`frigate: subscribe failed: ${err.message}`);
      });
    });
    this.client.on('reconnect', () => this.log.debug('frigate: reconnecting'));
    this.client.on('error', (err) => this.log.warn(`frigate: mqtt error: ${err.message}`));
    this.client.on('message', (topic, payload, packet) => {
      if (topic === this.eventsTopic) this.ingestEvent(payload);
      else if (topic.endsWith('/snapshot')) this.ingestSnapshot(topic, payload, packet.retain);
    });
  }

  /** Parse a `frigate/events` payload and update per-label metadata. */
  ingestEvent(payload: Buffer): void {
    let after: Record<string, unknown> | undefined;
    try {
      after = (JSON.parse(payload.toString('utf8')) as { after?: Record<string, unknown> }).after;
    } catch {
      return;
    }
    if (!after) return;

    const label = typeof after.label === 'string' ? after.label.toLowerCase() : '';
    if (!this.labels.has(label)) return;
    const camera = typeof after.camera === 'string' ? after.camera : '';
    if (this.cfg.camera && camera !== this.cfg.camera) return;
    if (after.false_positive === true) return;

    const seconds =
      typeof after.frame_time === 'number'
        ? after.frame_time
        : typeof after.start_time === 'number'
          ? after.start_time
          : undefined;
    const ts = seconds !== undefined ? seconds * 1000 : Date.now();
    const score = typeof after.score === 'number' ? after.score : Number(after.top_score) || 0;

    const rec = this.store.get(label) ?? { label, camera, lastSeen: 0, score: 0 };
    if (ts >= rec.lastSeen) {
      rec.lastSeen = ts;
      if (score) rec.score = score;
      if (camera) rec.camera = camera;
    }
    this.store.set(label, rec);
  }

  /** Store the JPEG from a `<prefix>/<camera>/<label>/snapshot` message. */
  ingestSnapshot(topic: string, payload: Buffer, retained: boolean): void {
    const parts = topic.split('/');
    const camera = parts[parts.length - 3] ?? '';
    const label = (parts[parts.length - 2] ?? '').toLowerCase();
    if (!this.labels.has(label)) return;
    if (this.cfg.camera && camera !== this.cfg.camera) return;
    if (payload.length === 0) return;

    const rec = this.store.get(label) ?? { label, camera, lastSeen: 0, score: 0 };
    rec.image = payload;
    rec.imageAt = Date.now();
    if (!rec.camera && camera) rec.camera = camera;
    // A live (non-retained) snapshot means a detection just ended — use it as a
    // timing hint if no matching event arrived. Retained images are historical,
    // so we don't trust their timing (leave lastSeen at 0 = "recently").
    if (!retained && rec.lastSeen === 0) rec.lastSeen = rec.imageAt;
    this.store.set(label, rec);
  }

  list(): Detection[] {
    return [...this.store.values()]
      .filter((d) => d.image)
      .sort((a, b) => b.lastSeen - a.lastSeen);
  }

  getImage(label: string): Buffer | undefined {
    return this.store.get(label.toLowerCase())?.image;
  }

  async stop(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (!client) return;
    await new Promise<void>((resolve) => client.end(false, {}, () => resolve()));
  }
}
