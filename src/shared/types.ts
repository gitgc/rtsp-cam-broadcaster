/**
 * The wire contract between the Fastify server and the React client.
 *
 * Both sides import these, so a change to a response shape is a type error on
 * whichever side hasn't caught up yet.
 */

/** One "recently spotted" animal, as returned by `GET /api/detections`. */
export interface DetectionDto {
  /** Frigate object label, lowercased (e.g. `deer`). */
  label: string
  camera: string
  /** Epoch ms of the last sighting; `null` when only a historical snapshot exists. */
  lastSeen: number | null
  score: number | null
  /** Snapshot URL, versioned by `?ts=` so each revision caches immutably. */
  image: string
}

export interface DetectionsResponse {
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
