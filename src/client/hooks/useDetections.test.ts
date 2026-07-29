import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from 'vitest-browser-react'
import type { DetectionDto } from '../../shared/types.js'
import { useDetections } from './useDetections.js'

const TICK_MS = 20
const idle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const DEER: DetectionDto = {
  id: 1,
  label: 'deer',
  camera: 'roaming',
  seenAt: 1700000000000,
  score: 0.9,
  image: '/api/detections/deer/snapshot.jpg?ts=1',
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useDetections', () => {
  it('starts empty and fills in from the endpoint', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json({ detections: [DEER] }))),
    )

    const view = await renderHook(() => useDetections(60_000))
    expect(view.result.current).toEqual([])

    await vi.waitFor(() => expect(view.result.current).toEqual([DEER]))
  })

  it('keeps the last good list when a later poll fails', async () => {
    // The grid must not flicker to empty on a transient network blip.
    let offline = false
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        offline
          ? Promise.reject(new Error('offline'))
          : Promise.resolve(Response.json({ detections: [DEER] })),
      ),
    )

    const view = await renderHook(() => useDetections(TICK_MS))
    await vi.waitFor(() => expect(view.result.current).toEqual([DEER]))

    offline = true
    await idle(TICK_MS * 6)

    expect(view.result.current).toEqual([DEER])
  })

  it('clears the list when the server legitimately reports nothing', async () => {
    // An empty array is real data ("nothing spotted lately"), unlike a failure.
    let detections: DetectionDto[] = [DEER]
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json({ detections }))),
    )

    const view = await renderHook(() => useDetections(TICK_MS))
    await vi.waitFor(() => expect(view.result.current).toEqual([DEER]))

    detections = []
    await vi.waitFor(() => expect(view.result.current).toEqual([]))
  })

  it('stops polling after unmount', async () => {
    const fetchMock = vi.fn<() => Promise<Response>>(() =>
      Promise.resolve(Response.json({ detections: [] })),
    )
    vi.stubGlobal('fetch', fetchMock)

    const view = await renderHook(() => useDetections(TICK_MS))
    await vi.waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2))
    await view.unmount()
    const callsAtUnmount = fetchMock.mock.calls.length

    await idle(TICK_MS * 6)
    expect(fetchMock.mock.calls.length).toBe(callsAtUnmount)
  })
})
