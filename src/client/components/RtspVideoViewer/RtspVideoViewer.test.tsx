import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import type { PlaybackState } from '../../hooks/useHlsPlayer.js'
import { createFakeHls, emitFatalError, FAKE_ERROR_TYPES } from '../../test/fakeHls.js'
import { RtspVideoViewer } from './RtspVideoViewer.js'

/** The overlay is faded out rather than unmounted, so check the class. */
function overlayHidden(container: HTMLElement): boolean {
  return container.querySelector('.overlay')?.classList.contains('hidden') ?? false
}

function videoIn(container: HTMLElement): HTMLVideoElement {
  const video = container.querySelector('video')
  if (!video) throw new Error('no <video> rendered')
  return video
}

describe('RtspVideoViewer', () => {
  it('shows the warming-up overlay before anything has played', async () => {
    const hls = createFakeHls()
    const screen = await render(<RtspVideoViewer loadHls={hls.loader} />)

    await expect.element(screen.getByRole('status')).toHaveTextContent('Warming up the coop…')
    expect(overlayHidden(screen.container)).toBe(false)
  })

  it('points hls.js at the playlist and attaches it to the video element', async () => {
    const hls = createFakeHls()
    const screen = await render(<RtspVideoViewer src="/hls/custom.m3u8" loadHls={hls.loader} />)

    await vi.waitFor(() => expect(hls.instance).not.toBeNull())
    expect(hls.instance?.source).toBe('/hls/custom.m3u8')
    expect(hls.instance?.media).toBe(videoIn(screen.container))
  })

  it('hides the overlay once the video reports real progress', async () => {
    const hls = createFakeHls()
    const screen = await render(<RtspVideoViewer loadHls={hls.loader} />)

    videoIn(screen.container).dispatchEvent(new Event('playing'))

    await vi.waitFor(() => expect(overlayHidden(screen.container)).toBe(true))
  })

  it('reports playback state upward so the header can light up', async () => {
    const seen: PlaybackState[] = []
    const hls = createFakeHls()
    const screen = await render(
      <RtspVideoViewer loadHls={hls.loader} onStateChange={(state) => seen.push(state)} />,
    )

    expect(seen).toEqual(['connecting'])
    videoIn(screen.container).dispatchEvent(new Event('playing'))

    await vi.waitFor(() => expect(seen).toContain('playing'))
  })

  it('says "Reconnecting…" and retries the load on a fatal network error', async () => {
    const hls = createFakeHls()
    const screen = await render(<RtspVideoViewer loadHls={hls.loader} />)
    await vi.waitFor(() => expect(hls.instance).not.toBeNull())

    videoIn(screen.container).dispatchEvent(new Event('playing'))
    await vi.waitFor(() => expect(overlayHidden(screen.container)).toBe(true))

    emitFatalError(hls.instance!, FAKE_ERROR_TYPES.NETWORK_ERROR)

    await expect.element(screen.getByRole('status')).toHaveTextContent('Reconnecting…')
    // The retry is deliberately delayed (~1.5s) so we don't hammer a down origin.
    await vi.waitFor(() => expect(hls.instance!.startLoadCount).toBeGreaterThan(0), {
      timeout: 4000,
    })
  })

  it('asks hls.js to self-heal on a fatal media error', async () => {
    const hls = createFakeHls()
    const screen = await render(<RtspVideoViewer loadHls={hls.loader} />)
    await vi.waitFor(() => expect(hls.instance).not.toBeNull())

    emitFatalError(hls.instance!, FAKE_ERROR_TYPES.MEDIA_ERROR)

    await expect.element(screen.getByRole('status')).toHaveTextContent('Recovering…')
    expect(hls.instance!.recoverMediaErrorCount).toBe(1)
  })

  it('ignores non-fatal errors — they self-heal and must not alarm the viewer', async () => {
    const hls = createFakeHls()
    const screen = await render(<RtspVideoViewer loadHls={hls.loader} />)
    await vi.waitFor(() => expect(hls.instance).not.toBeNull())

    videoIn(screen.container).dispatchEvent(new Event('playing'))
    await vi.waitFor(() => expect(overlayHidden(screen.container)).toBe(true))

    hls.instance!.emit('hlsError', 'hlsError', { fatal: false, type: 'networkError' })

    expect(overlayHidden(screen.container)).toBe(true)
  })

  it('falls back to native HLS when MSE is unavailable (iOS Safari)', async () => {
    const canPlay = vi
      .spyOn(HTMLVideoElement.prototype, 'canPlayType')
      .mockReturnValue('maybe' as CanPlayTypeResult)

    const hls = createFakeHls({ supported: false })
    const screen = await render(<RtspVideoViewer src="/hls/native.m3u8" loadHls={hls.loader} />)

    await vi.waitFor(() => {
      expect(videoIn(screen.container).getAttribute('src')).toBe('/hls/native.m3u8')
    })
    expect(hls.instance).toBeNull() // never constructed — nothing to tear down

    canPlay.mockRestore()
  })

  it('tells the viewer plainly when the browser cannot play HLS at all', async () => {
    // No MSE and no native HLS — nothing left to try. Chromium reports "maybe"
    // for the HLS MIME type, so the no-support case has to be forced.
    const canPlay = vi
      .spyOn(HTMLVideoElement.prototype, 'canPlayType')
      .mockReturnValue('' as CanPlayTypeResult)

    const hls = createFakeHls({ supported: false })
    const screen = await render(<RtspVideoViewer loadHls={hls.loader} />)

    await expect
      .element(screen.getByRole('status'))
      .toHaveTextContent('Your browser can’t play this stream.')
    // No spinner: implying "still trying" would be a lie.
    expect(screen.container.querySelector('.spinner')).toBeNull()

    canPlay.mockRestore()
  })

  it('tears hls.js down on unmount so a closed tab stops fetching segments', async () => {
    const hls = createFakeHls()
    const screen = await render(<RtspVideoViewer loadHls={hls.loader} />)
    await vi.waitFor(() => expect(hls.instance).not.toBeNull())

    await screen.unmount()

    expect(hls.instance!.destroyed).toBe(true)
  })
})
