import { useCallback, useState } from 'react'
import type { DetectionDto } from '../../../shared/types.js'
import { Lightbox } from '../Lightbox/Lightbox.js'
import { SightingCard } from '../SightingCard/SightingCard.js'
import './RecentlySpotted.css'

export interface RecentlySpottedProps {
  /** Newest first, as the server orders them. */
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

  if (detections.length === 0) return null

  return (
    <section className="sightings" aria-labelledby="sightings-title">
      <h2 className="sightings-title" id="sightings-title">
        Recently spotted <span aria-hidden="true">🐾</span>
      </h2>

      <div className="sightings-grid">
        {detections.map((detection) => (
          <SightingCard key={detection.label} detection={detection} onSelect={setSelected} />
        ))}
      </div>

      <Lightbox detection={selected} onClose={close} />
    </section>
  )
}
