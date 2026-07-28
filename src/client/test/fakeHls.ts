import type { HlsLoader, HlsModule } from '../hooks/useHlsPlayer.js'

/**
 * A stand-in for hls.js. Real playback needs a live MSE stream, which a unit
 * test can't provide — but every branch the player cares about (fatal network
 * error, media error, unrecoverable error) is reachable by emitting the
 * corresponding event on this fake.
 */

export const FAKE_EVENTS = {
  MANIFEST_PARSED: 'hlsManifestParsed',
  FRAG_BUFFERED: 'hlsFragBuffered',
  ERROR: 'hlsError',
} as const

export const FAKE_ERROR_TYPES = {
  NETWORK_ERROR: 'networkError',
  MEDIA_ERROR: 'mediaError',
  OTHER_ERROR: 'otherError',
} as const

export interface FakeHlsInstance {
  source: string | null
  media: HTMLMediaElement | null
  startLoadCount: number
  recoverMediaErrorCount: number
  destroyed: boolean
  emit(event: string, ...args: unknown[]): void
}

export interface FakeHls {
  /** Pass as the `loadHls` prop / option. */
  loader: HlsLoader
  /** The instance the player constructed, or `null` if it hasn't yet. */
  readonly instance: FakeHlsInstance | null
}

export function createFakeHls({ supported = true } = {}): FakeHls {
  let created: FakeHlsInstance | null = null
  const record = (instance: FakeHlsInstance): void => {
    created = instance
  }

  class FakeHlsClass implements FakeHlsInstance {
    static readonly Events = FAKE_EVENTS
    static readonly ErrorTypes = FAKE_ERROR_TYPES
    static isSupported(): boolean {
      return supported
    }

    source: string | null = null
    media: HTMLMediaElement | null = null
    startLoadCount = 0
    recoverMediaErrorCount = 0
    destroyed = false
    private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>()

    constructor() {
      record(this)
    }

    loadSource(src: string): void {
      this.source = src
    }

    attachMedia(media: HTMLMediaElement): void {
      this.media = media
    }

    on(event: string, handler: (...args: unknown[]) => void): void {
      const handlers = this.listeners.get(event) ?? []
      handlers.push(handler)
      this.listeners.set(event, handlers)
    }

    emit(event: string, ...args: unknown[]): void {
      for (const handler of this.listeners.get(event) ?? []) handler(...args)
    }

    startLoad(): void {
      this.startLoadCount += 1
    }

    recoverMediaError(): void {
      this.recoverMediaErrorCount += 1
    }

    destroy(): void {
      this.destroyed = true
    }
  }

  return {
    loader: () => Promise.resolve({ default: FakeHlsClass } as unknown as HlsModule),
    get instance() {
      return created
    },
  }
}

/** Emits a fatal hls.js error of the given type on the fake instance. */
export function emitFatalError(instance: FakeHlsInstance, type: string): void {
  instance.emit(FAKE_EVENTS.ERROR, FAKE_EVENTS.ERROR, { fatal: true, type })
}
