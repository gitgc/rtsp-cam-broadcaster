import { useEffect, useRef } from 'react'
import type { DetectionDto } from '../../../shared/types.js'
import { labelDisplay } from '../../lib/labels.js'
import { absoluteTime, UNDATED_LABEL, UNDATED_TITLE } from '../../lib/time.js'
import './Lightbox.css'

export interface LightboxProps {
  /** The sighting to enlarge, or `null` when closed. */
  detection: DetectionDto | null
  /** Must be referentially stable — it drives the open/close effect. */
  onClose: () => void
}

/**
 * Click-to-enlarge overlay, built on a native `<dialog>`: `showModal()` gives us
 * the focus trap, Escape-to-close, background inertness and focus restoration
 * for free, instead of hand-rolling all four.
 *
 * The image URL is the same one the card already loaded, so opening is instant
 * from cache.
 */
export function Lightbox({ detection, onClose }: LightboxProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return

    if (!detection) {
      // Closing through the element (rather than unmounting it) is what lets
      // the browser hand focus back to the card that opened it.
      if (dialog.open) dialog.close()
      return
    }

    dialog.showModal()

    // Light dismiss: a click that lands on the dialog element itself hit the
    // backdrop, not the content. Bound here rather than as an onClick prop so
    // the handler sits next to showModal(), which is what makes it reachable.
    const onBackdropClick = (event: MouseEvent): void => {
      if (event.target === dialog) onClose()
    }
    dialog.addEventListener('click', onBackdropClick)

    return () => dialog.removeEventListener('click', onBackdropClick)
  }, [detection, onClose])

  const name = detection ? labelDisplay(detection.label) : undefined

  // The element stays mounted across open/close; only its contents come and go.
  return (
    <dialog
      ref={dialogRef}
      className="lightbox"
      aria-label={name}
      // Fires for Escape and for the programmatic close above.
      onClose={onClose}
    >
      {detection && (
        <>
          <button className="lightbox-close" type="button" aria-label="Close" onClick={onClose}>
            &times;
          </button>

          <figure className="lightbox-inner">
            <img className="lightbox-img" src={detection.image} alt={name} />
            <figcaption className="lightbox-cap">
              <span className="lightbox-name">{name}</span>
              {/* Same as the card: no machine-readable value means no <time>. */}
              {detection.lastSeen ? (
                <time
                  className="lightbox-time"
                  dateTime={new Date(detection.lastSeen).toISOString()}
                >
                  {absoluteTime(detection.lastSeen)}
                </time>
              ) : (
                <span className="lightbox-time" title={UNDATED_TITLE}>
                  {UNDATED_LABEL}
                </span>
              )}
            </figcaption>
          </figure>
        </>
      )}
    </dialog>
  )
}
