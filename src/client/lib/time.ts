/**
 * Coarse "how long ago" formatting for sighting timestamps.
 *
 * `now` is injectable so tests don't depend on the wall clock.
 */
export function relativeTime(
  timestamp: number | null | undefined,
  now: number = Date.now(),
): string {
  if (!timestamp) return 'recently'

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
