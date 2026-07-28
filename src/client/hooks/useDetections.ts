import { useCallback, useState } from 'react'
import type { DetectionDto } from '../../shared/types.js'
import { fetchDetections } from '../lib/api.js'
import { useVisiblePolling } from './useVisiblePolling.js'

/** Frigate sightings are minutes-scale events; 30s is plenty fresh. */
const POLL_MS = 30_000

/**
 * The "recently spotted" list. Starts empty and stays at the last good value
 * across transient fetch failures, so the grid never flickers to empty.
 */
export function useDetections(intervalMs: number = POLL_MS): DetectionDto[] {
  const [detections, setDetections] = useState<DetectionDto[]>([])

  const poll = useCallback(() => {
    void (async () => {
      const items = await fetchDetections()
      if (items !== null) setDetections(items)
    })()
  }, [])

  useVisiblePolling(poll, intervalMs)

  return detections
}
