import { useEffect } from 'react'
import { useHlsPlayer, type HlsLoader, type PlaybackState } from '../../hooks/useHlsPlayer.js'
import './RtspVideoViewer.css'

/** What the overlay says for each non-playing state. */
const OVERLAY_MESSAGE: Record<Exclude<PlaybackState, 'playing'>, string> = {
  connecting: 'Warming up the coop…',
  buffering: 'Buffering…',
  reconnecting: 'Reconnecting…',
  recovering: 'Recovering…',
  unsupported: 'Your browser can’t play this stream.',
}

export interface RtspVideoViewerProps {
  /** HLS playlist URL. */
  src?: string
  /** Seam for tests — swap in a stub hls.js module. */
  loadHls?: HlsLoader
  /** Lets the page react to playback health (e.g. the header's LIVE badge). */
  onStateChange?: (state: PlaybackState) => void
}

export function RtspVideoViewer({
  src = '/hls/stream.m3u8',
  loadHls,
  onStateChange,
}: RtspVideoViewerProps) {
  const { videoRef, state } = useHlsPlayer({ src, loadHls })

  useEffect(() => {
    onStateChange?.(state)
  }, [state, onStateChange])

  const message = state === 'playing' ? null : OVERLAY_MESSAGE[state]

  return (
    <div className="player">
      {/* A live camera feed has no captions to offer. */}
      {/* oxlint-disable-next-line jsx-a11y/media-has-caption */}
      <video ref={videoRef} aria-label="Live camera stream" playsInline autoPlay muted controls />

      {/* Kept mounted and faded out rather than unmounted, so the <output>
          stays a stable live region across state changes. */}
      <div className={message === null ? 'overlay hidden' : 'overlay'}>
        {state !== 'unsupported' && <div className="spinner" aria-hidden="true" />}
        <output className="overlay-message">{message ?? ''}</output>
      </div>
    </div>
  )
}
