const STORAGE_KEY = 'cluckcam:viewer-id'

function randomId(): string {
  return typeof crypto?.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${String(Math.random()).slice(2)}`
}

/**
 * A viewer id that survives reloads and extra tabs, so the presence count means
 * "people watching" rather than "tabs open". localStorage is shared across tabs
 * of the same origin, which is exactly the grouping we want.
 *
 * Private mode / disabled storage throws — fall back to a per-load id, which
 * over-counts slightly rather than failing.
 */
export function stableViewerId(storage: Storage | undefined = globalThis.localStorage): string {
  try {
    const existing = storage?.getItem(STORAGE_KEY)
    if (existing) return existing

    const fresh = randomId()
    storage?.setItem(STORAGE_KEY, fresh)
    return fresh
  } catch {
    return randomId()
  }
}
