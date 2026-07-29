import type { DetectionDto } from '../../../shared/types.js'
import { labelDisplay, labelTitle } from '../../lib/labels.js'
import { absoluteTime, relativeTime, UNDATED_TITLE } from '../../lib/time.js'
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
  const seenAt = detection.lastSeen

  return (
    <button
      type="button"
      className="sighting"
      aria-label={`Enlarge ${title} snapshot`}
      onClick={() => onSelect(detection)}
    >
      <img loading="lazy" alt="" src={detection.image} />
      <span className="sighting-caption">
        <span className="sighting-name">{labelDisplay(detection.label)}</span>
        {/* <time> needs a machine-readable value, which an undated retained
            snapshot doesn't have — so it degrades to a plain span. */}
        {seenAt ? (
          <time
            className="sighting-time"
            dateTime={new Date(seenAt).toISOString()}
            title={absoluteTime(seenAt)}
          >
            {relativeTime(seenAt)}
          </time>
        ) : (
          <span className="sighting-time" title={UNDATED_TITLE}>
            {relativeTime(seenAt)}
          </span>
        )}
      </span>
    </button>
  )
}
