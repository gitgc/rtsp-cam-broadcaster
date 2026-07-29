import type { DetectionDto } from '../../../shared/types.js'
import { labelDisplay, labelTitle } from '../../lib/labels.js'
import { absoluteTime, relativeTime } from '../../lib/time.js'
import './SightingCard.css'

export interface SightingCardProps {
  detection: DetectionDto
  onSelect: (detection: DetectionDto) => void
}

/**
 * One snapshot tile. It's a real `<button>` rather than a div with a click
 * handler, so keyboard activation, focus rings and screen-reader semantics all
 * come for free.
 */
export function SightingCard({ detection, onSelect }: SightingCardProps) {
  const title = labelTitle(detection.label)
  const seenAt = detection.seenAt

  return (
    <button
      type="button"
      className="sighting"
      // The same animal now has several cards in the grid, so the time is part
      // of the name — otherwise a screen reader announces five identical
      // "Enlarge Deer snapshot" buttons.
      aria-label={`Enlarge ${title} snapshot (${relativeTime(seenAt)})`}
      onClick={() => onSelect(detection)}
    >
      <img loading="lazy" alt="" src={detection.image} />
      <span className="sighting-caption">
        <span className="sighting-name">{labelDisplay(detection.label)}</span>
        <time
          className="sighting-time"
          dateTime={new Date(seenAt).toISOString()}
          title={absoluteTime(seenAt)}
        >
          {relativeTime(seenAt)}
        </time>
      </span>
    </button>
  )
}
