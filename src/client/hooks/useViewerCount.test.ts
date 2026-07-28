import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from 'vitest-browser-react'
import { useViewerCount } from './useViewerCount.js'

const TICK_MS = 20

function stubApi(viewers = 3) {
  const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(() =>
    Promise.resolve(Response.json({ viewers })),
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const idsFrom = (mock: ReturnType<typeof stubApi>): string[] =>
  mock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)).id as string)

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useViewerCount', () => {
  it('is null until the first heartbeat comes back', async () => {
    stubApi(9)
    const view = await renderHook(() => useViewerCount(60_000))

    // null renders as "–" rather than a misleading 0.
    expect(view.result.current).toBeNull()
    await vi.waitFor(() => expect(view.result.current).toBe(9))
  })

  it('sends the same viewer id on every beat', async () => {
    const fetchMock = stubApi()
    await renderHook(() => useViewerCount(TICK_MS))

    await vi.waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3))

    // One browser must count as one viewer no matter how many beats it sends.
    expect(new Set(idsFrom(fetchMock)).size).toBe(1)
  })

  it('holds the last known count when a beat fails', async () => {
    let offline = false
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        offline
          ? Promise.reject(new Error('offline'))
          : Promise.resolve(Response.json({ viewers: 5 })),
      ),
    )

    const view = await renderHook(() => useViewerCount(TICK_MS))
    await vi.waitFor(() => expect(view.result.current).toBe(5))

    offline = true
    await new Promise((resolve) => setTimeout(resolve, TICK_MS * 6))

    expect(view.result.current).toBe(5)
  })

  it('beacons a leave when the tab goes away', async () => {
    const fetchMock = stubApi()
    const beacon = vi.fn<(url: string) => boolean>(() => true)
    vi.stubGlobal('navigator', { ...navigator, sendBeacon: beacon })

    await renderHook(() => useViewerCount(60_000))
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())

    window.dispatchEvent(new Event('pagehide'))

    // Same id as the heartbeats, so the server drops the right session.
    const [id] = idsFrom(fetchMock)
    expect(beacon).toHaveBeenCalledExactlyOnceWith(`/api/leave?id=${encodeURIComponent(id!)}`)
  })

  it('stops beaconing once unmounted', async () => {
    stubApi()
    const beacon = vi.fn<(url: string) => boolean>(() => true)
    vi.stubGlobal('navigator', { ...navigator, sendBeacon: beacon })

    const view = await renderHook(() => useViewerCount(60_000))
    await view.unmount()

    window.dispatchEvent(new Event('pagehide'))

    expect(beacon).not.toHaveBeenCalled()
  })
})
