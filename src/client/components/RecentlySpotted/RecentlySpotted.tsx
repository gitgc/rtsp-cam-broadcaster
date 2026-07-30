import { useCallback, useState } from 'react'
import type { DetectionDto } from '../../../shared/types.js'
import { Lightbox } from '../Lightbox/Lightbox.js'
import { SightingCard } from '../SightingCard/SightingCard.js'
import './RecentlySpotted.css'

/**
 * How many cards the grid renders.
 *
 * The server can hold many more — 5 snapshots per label across every label it
 * tracks is 50 with the default set — but this is a glance-at-it panel under
 * the video, not an archive. Capping it bounds both the scrolling and the image
 * bytes a visitor pulls.
 */
export const MAX_RENDERED_SIGHTINGS = 18

export interface RecentlySpottedProps {
  /**
   * One entry per stored snapshot, **newest first**, as the server orders them
   * (see `list()` in src/server/frigate.ts). Only the first
   * {@link MAX_RENDERED_SIGHTINGS} are rendered, so that ordering is what makes
   * the grid show the most recent sightings.
   *
   * The same animal appears several times — the server keeps the last few
   * snapshots per label — so entries are keyed by id, not label.
   */
  detections: DetectionDto[]
}

/**
 * The grid of recent Frigate sightings. Renders nothing at all when there's
 * nothing to show, so an unconfigured (or quiet) camera leaves no empty shell
 * on the page.
 */
export function RecentlySpotted({ detections }: RecentlySpottedProps) {
  const [selected, setSelected] = useState<DetectionDto | null>(null)
  const close = useCallback(() => setSelected(null), [])

  // Input is newest-first, so the head of the list is the most recent.
  const visible = detections.slice(0, MAX_RENDERED_SIGHTINGS)
  if (visible.length === 0) return null

  return (
    <section className="sightings" aria-labelledby="sightings-title">
      <h2 className="sightings-title" id="sightings-title">
        Recently spotted <span aria-hidden="true">🐾</span>
      </h2>

      <div className="sightings-grid">
        {visible.map((detection) => (
          <SightingCard key={detection.id} detection={detection} onSelect={setSelected} />
        ))}
      </div>

      <Lightbox detection={selected} onClose={close} />
    </section>
  )
}
