/**
 * The wire contract between the Fastify server and the React client.
 *
 * Both sides import these, so a change to a response shape is a type error on
 * whichever side hasn't caught up yet.
 */

/**
 * One snapshot of one animal, as returned by `GET /api/detections`.
 *
 * The server keeps the last few snapshots per label (see
 * MAX_SNAPSHOTS_PER_LABEL in src/server/frigate.ts), so the same `label` can
 * appear more than once — `id` is what uniquely identifies a sighting.
 */
export interface DetectionDto {
  /**
   * Identifies this sighting within one response — use it as the list key.
   * Process-local, so don't persist it or build URLs from it.
   */
  id: number
  /** Frigate object label, lowercased (e.g. `deer`). */
  label: string
  camera: string
  /**
   * Epoch ms the animal was seen. Always a real time: the server only stores
   * snapshots from detections that happened while it was running.
   */
  seenAt: number
  score: number | null
  /**
   * Snapshot URL. Content-addressed, so it names exactly these bytes and is
   * safe to cache forever — including across server restarts.
   */
  image: string
}

export interface DetectionsResponse {
  /** Newest first. */
  detections: DetectionDto[]
}

/** `POST /api/heartbeat` — the live viewer count after recording this beat. */
export interface HeartbeatResponse {
  viewers: number
}

/**
 * Deploy-time config the server templates into the page HTML, so the client
 * doesn't need a round-trip to render the title above the fold.
 */
export interface AppBootstrap {
  title: string
  tagline: string
}
