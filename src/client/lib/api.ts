import type { DetectionDto, DetectionsResponse, HeartbeatResponse } from '../../shared/types.js'

// NB: this lives in lib/ rather than an api/ folder on purpose. Vite dev serves
// source modules at their path under the client root, so src/client/api/*.ts
// would be requested as /api/*.ts — which the dev proxy forwards to Fastify,
// and the module 404s. Don't name a client directory after a proxied prefix
// (/api, /hls); see the proxy config in vite.config.ts.

/**
 * Thin wrappers over the server's JSON endpoints.
 *
 * Every call resolves to `null` on any failure instead of rejecting: all three
 * are polled on a timer, so a transient error just means "no update this tick"
 * and the next poll recovers. Callers keep showing the last good value.
 */

async function getJson<T>(url: string, init?: RequestInit): Promise<T | null> {
  try {
    const response = await fetch(url, init)
    if (!response.ok) return null
    return (await response.json()) as T
  } catch {
    return null
  }
}

/** Records a beat and returns the current viewer count. */
export async function sendHeartbeat(id: string): Promise<number | null> {
  const body = await getJson<HeartbeatResponse>('/api/heartbeat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
    // Survives the tab being torn down mid-flight.
    keepalive: true,
  })
  return typeof body?.viewers === 'number' ? body.viewers : null
}

/**
 * Drops this viewer from the count immediately on tab close. Uses `sendBeacon`
 * because a normal fetch is cancelled once the page is gone.
 */
export function sendLeave(id: string): void {
  try {
    navigator.sendBeacon(`/api/leave?id=${encodeURIComponent(id)}`)
  } catch {
    // The TTL on the server will expire the session anyway.
  }
}

export async function fetchDetections(): Promise<DetectionDto[] | null> {
  const body = await getJson<DetectionsResponse>('/api/detections')
  return Array.isArray(body?.detections) ? body.detections : null
}
