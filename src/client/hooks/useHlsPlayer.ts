import type HlsJs from 'hls.js'
import { useEffect, useRef, useState, type RefObject } from 'react'

/**
 * HLS playback tuned for STABILITY over latency (it's a chicken cam, not a
 * video call). We sit a few segments behind the live edge, buffer generously,
 * and only surface an overlay after a *sustained* freeze — brief rebuffers are
 * invisible.
 */

export type PlaybackState =
  /** Attached, nothing has played yet. */
  | 'connecting'
  | 'playing'
  | 'buffering'
  | 'reconnecting'
  | 'recovering'
  /** No MSE and no native HLS — nothing we can do. */
  | 'unsupported'

type HlsClass = typeof HlsJs
type HlsInstance = HlsJs
/** The shape of the lazily-imported hls.js module. */
export interface HlsModule {
  default: HlsClass
}
export type HlsLoader = () => Promise<HlsModule>

const SOFT_FREEZE_MS = 3_000 // quiet "Buffering…" after this long frozen
const HARD_FREEZE_MS = 10_000 // escalate to "Reconnecting…" + recover only after a
// real, sustained stall — mobile/cellular rebuffers of a few seconds are normal
// and self-heal, so we don't want to alarm on them.
const WATCHDOG_MS = 1_000
const RECOVER_COOLDOWN_MS = 4_000
const NETWORK_RETRY_MS = 1_500
const NATIVE_RETRY_MS = 3_000
const FULL_RESET_MS = 5_000

const HLS_CONFIG = {
  lowLatencyMode: false, // stability > latency
  liveSyncDurationCount: 4, // sit ~4 segments behind live for a buffer cushion
  liveMaxLatencyDurationCount: 15, // allow drifting well back before hard-seeking
  maxBufferLength: 30, // build up to 30s of forward buffer when available
  maxMaxBufferLength: 60,
  backBufferLength: 30,
}

/** Code-split: the ~400KB hls.js chunk isn't part of the initial page load. */
const defaultLoader: HlsLoader = () => import('hls.js')

export interface UseHlsPlayerOptions {
  /** HLS playlist URL. */
  src: string
  /** Seam for tests — swap in a stub hls.js module. */
  loadHls?: HlsLoader
}

export interface HlsPlayer {
  videoRef: RefObject<HTMLVideoElement | null>
  state: PlaybackState
}

export function useHlsPlayer({ src, loadHls = defaultLoader }: UseHlsPlayerOptions): HlsPlayer {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [state, setState] = useState<PlaybackState>('connecting')
  /** Bumping this tears the player down and rebuilds it from scratch. */
  const [resetToken, setResetToken] = useState(0)

  // Read through a ref so an inline `loadHls` prop can't restart playback on
  // every render.
  const loaderRef = useRef(loadHls)
  useEffect(() => {
    loaderRef.current = loadHls
  }, [loadHls])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    let disposed = false
    let hls: HlsInstance | null = null
    let lastProgressAt = Date.now()
    let lastMediaTime = 0
    let recoverBlockedUntil = 0
    const timers = new Set<ReturnType<typeof setTimeout>>()

    const later = (run: () => void, ms: number): void => {
      const timer = setTimeout(() => {
        timers.delete(timer)
        if (!disposed) run()
      }, ms)
      timers.add(timer)
    }

    // Autoplay can be refused (no user gesture); the controls are still there.
    const play = (): void => void video.play().catch(() => {})

    /** Any real playback progress means we're healthy. */
    const markProgress = (): void => {
      lastProgressAt = Date.now()
      setState('playing')
    }

    const onTimeUpdate = (): void => {
      if (video.currentTime !== lastMediaTime) {
        lastMediaTime = video.currentTime
        markProgress()
      }
    }

    /**
     * Gentle recovery: resume loading and let the buffer refill / hls.js nudge
     * across gaps. We deliberately DON'T seek to the live edge here — that's the
     * point with the least buffer, so forcing it on every hiccup just re-stalls.
     * hls.js catches up on its own once it drifts past liveMaxLatencyDuration.
     */
    const recover = (): void => {
      const now = Date.now()
      if (now < recoverBlockedUntil) return
      recoverBlockedUntil = now + RECOVER_COOLDOWN_MS
      hls?.startLoad()
      play()
    }

    /** Safari's own error handling: re-point at the playlist and reload. */
    const onNativeError = (): void => {
      setState('reconnecting')
      later(() => {
        video.src = src
        video.load()
        play()
      }, NATIVE_RETRY_MS)
    }

    const attachNative = (): void => {
      video.src = src
      video.addEventListener('error', onNativeError)
      play()
    }

    const attachHlsJs = (Hls: HlsClass): void => {
      const instance = new Hls(HLS_CONFIG)
      hls = instance

      instance.loadSource(src)
      instance.attachMedia(video)
      instance.on(Hls.Events.MANIFEST_PARSED, play)
      instance.on(Hls.Events.FRAG_BUFFERED, markProgress)
      instance.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal) return
        switch (data.type) {
          case Hls.ErrorTypes.NETWORK_ERROR:
            setState('reconnecting')
            later(() => instance.startLoad(), NETWORK_RETRY_MS)
            break
          case Hls.ErrorTypes.MEDIA_ERROR:
            setState('recovering')
            instance.recoverMediaError()
            break
          default:
            // Unrecoverable. Rebuild the player wholesale — same effect as the
            // full page reload this used to do, without losing the rest of the
            // page (viewer count, sightings) along the way.
            setState('reconnecting')
            later(() => setResetToken((token) => token + 1), FULL_RESET_MS)
        }
      })
    }

    video.addEventListener('timeupdate', onTimeUpdate)
    video.addEventListener('playing', markProgress)

    // Single watchdog drives all "is it stuck?" decisions off actual progress,
    // instead of the noisy native stalled/waiting events.
    const watchdog = setInterval(() => {
      if (video.paused || video.ended || video.readyState === 0) return
      const frozenMs = Date.now() - lastProgressAt
      if (frozenMs > HARD_FREEZE_MS) {
        setState('reconnecting')
        recover()
      } else if (frozenMs > SOFT_FREEZE_MS) {
        setState('buffering')
      }
    }, WATCHDOG_MS)

    // Safari plays HLS natively; its own buffering is already conservative.
    const canPlayNative = video.canPlayType('application/vnd.apple.mpegurl') !== ''

    void (async () => {
      let module: HlsModule | null = null
      try {
        module = await loaderRef.current()
      } catch {
        // The hls.js chunk itself failed to load — native HLS is still a shot.
      }
      if (disposed) return

      if (module?.default.isSupported()) attachHlsJs(module.default)
      else if (canPlayNative) attachNative()
      else setState('unsupported')
    })()

    return () => {
      disposed = true
      clearInterval(watchdog)
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
      video.removeEventListener('timeupdate', onTimeUpdate)
      video.removeEventListener('playing', markProgress)
      video.removeEventListener('error', onNativeError)
      hls?.destroy()
      hls = null
    }
  }, [src, resetToken])

  return { videoRef, state }
}
