import { useCallback, useEffect, useState } from 'react'
import { sendHeartbeat, sendLeave } from '../lib/api.js'
import { stableViewerId } from '../lib/viewerId.js'
import { useVisiblePolling } from './useVisiblePolling.js'

/** ~2.5x under the server's presence TTL, so one dropped beat is harmless. */
const HEARTBEAT_MS = 20_000

/**
 * Keeps this browser counted as a live viewer and reports the current total.
 * Returns `null` until the first heartbeat lands.
 */
export function useViewerCount(intervalMs: number = HEARTBEAT_MS): number | null {
  const [viewers, setViewers] = useState<number | null>(null)
  const [id] = useState(stableViewerId)

  const beat = useCallback(() => {
    void (async () => {
      const count = await sendHeartbeat(id)
      if (count !== null) setViewers(count)
    })()
  }, [id])

  useVisiblePolling(beat, intervalMs)

  useEffect(() => {
    // `pagehide` (not `beforeunload`) is the one event that reliably fires on
    // iOS when a tab is closed or the app is backgrounded.
    const leave = (): void => sendLeave(id)
    window.addEventListener('pagehide', leave)
    return () => window.removeEventListener('pagehide', leave)
  }, [id])

  return viewers
}
