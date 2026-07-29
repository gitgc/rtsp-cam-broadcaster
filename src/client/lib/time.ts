/**
 * Shown when a snapshot's capture time is genuinely unknown.
 *
 * Frigate retains the last snapshot per label, so the broker replays them the
 * moment we subscribe — on every restart. Those images can be days old and
 * carry no timestamp, so the server reports `lastSeen: null` rather than
 * guessing (see ingestSnapshot in src/server/frigate.ts). Saying "recently"
 * here would assert something we don't know.
 */
export const UNDATED_LABEL = 'seen earlier'

export const UNDATED_TITLE =
  'This snapshot was already stored when the stream started, so its age is unknown'

/**
 * Coarse "how long ago" formatting for sighting timestamps.
 *
 * `now` is injectable so tests don't depend on the wall clock.
 */
export function relativeTime(
  timestamp: number | null | undefined,
  now: number = Date.now(),
): string {
  if (!timestamp) return UNDATED_LABEL

  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000))
  if (seconds < 60) return `${seconds}s ago`

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`

  return `${Math.floor(hours / 24)}d ago`
}

/** Absolute timestamp for tooltips and the lightbox caption. */
export function absoluteTime(timestamp: number | null | undefined): string | undefined {
  if (!timestamp) return undefined
  return new Date(timestamp).toLocaleString()
}
