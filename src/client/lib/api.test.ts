import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchDetections, sendHeartbeat, sendLeave } from './api.js'

type FetchMock = ReturnType<typeof stubFetch>

function stubFetch(impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  const mock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(impl)
  vi.stubGlobal('fetch', mock)
  return mock
}

const json = (body: unknown) => () => Promise.resolve(Response.json(body))
const lastInit = (mock: FetchMock): RequestInit | undefined => mock.mock.calls.at(-1)?.[1]

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('sendHeartbeat', () => {
  it('POSTs the viewer id as JSON and returns the count', async () => {
    const mock = stubFetch(json({ viewers: 12 }))

    await expect(sendHeartbeat('viewer-1')).resolves.toBe(12)

    expect(mock.mock.calls.at(-1)?.[0]).toBe('/api/heartbeat')
    expect(lastInit(mock)?.method).toBe('POST')
    expect(JSON.parse(String(lastInit(mock)?.body))).toEqual({ id: 'viewer-1' })
  })

  it('marks the request keepalive so a closing tab still counts', async () => {
    const mock = stubFetch(json({ viewers: 1 }))
    await sendHeartbeat('viewer-1')
    expect(lastInit(mock)?.keepalive).toBe(true)
  })

  it('returns null instead of throwing when the network is down', async () => {
    // The caller polls on a timer, so a failure just means "no update this
    // tick" — it must never surface as an unhandled rejection.
    stubFetch(() => Promise.reject(new Error('offline')))
    await expect(sendHeartbeat('viewer-1')).resolves.toBeNull()
  })

  it('returns null on an error response', async () => {
    stubFetch(() => Promise.resolve(new Response('nope', { status: 500 })))
    await expect(sendHeartbeat('viewer-1')).resolves.toBeNull()
  })

  it('returns null when the body is not the shape we expect', async () => {
    stubFetch(json({ viewers: 'lots' }))
    await expect(sendHeartbeat('viewer-1')).resolves.toBeNull()
  })

  it('returns null on a malformed JSON body', async () => {
    stubFetch(() =>
      Promise.resolve(
        new Response('{not json', { headers: { 'Content-Type': 'application/json' } }),
      ),
    )
    await expect(sendHeartbeat('viewer-1')).resolves.toBeNull()
  })
})

describe('fetchDetections', () => {
  it('returns the detections array', async () => {
    const detections = [
      { id: 1, label: 'deer', camera: 'roaming', seenAt: 1, score: 1, image: '/x' },
    ]
    stubFetch(json({ detections }))

    await expect(fetchDetections()).resolves.toEqual(detections)
  })

  it('returns null on failure, so callers can keep the last good list', async () => {
    stubFetch(() => Promise.reject(new Error('offline')))
    await expect(fetchDetections()).resolves.toBeNull()
  })

  it('returns null when detections is missing or not an array', async () => {
    stubFetch(json({}))
    await expect(fetchDetections()).resolves.toBeNull()

    stubFetch(json({ detections: 'nope' }))
    await expect(fetchDetections()).resolves.toBeNull()
  })

  it('distinguishes an empty list from a failure', async () => {
    // [] means "nothing spotted" and should clear the grid; null means "ask
    // again later" and should not.
    stubFetch(json({ detections: [] }))
    await expect(fetchDetections()).resolves.toEqual([])
  })
})

describe('sendLeave', () => {
  it('beacons the id so the count drops the moment the tab closes', () => {
    const beacon = vi.fn<(url: string) => boolean>(() => true)
    vi.stubGlobal('navigator', { ...navigator, sendBeacon: beacon })

    sendLeave('viewer 1/2')

    // sendBeacon survives page teardown where a normal fetch would be cancelled.
    expect(beacon).toHaveBeenCalledExactlyOnceWith('/api/leave?id=viewer%201%2F2')
  })

  it('swallows a sendBeacon that throws', () => {
    vi.stubGlobal('navigator', {
      ...navigator,
      sendBeacon: () => {
        throw new Error('blocked')
      },
    })

    // The server's presence TTL expires the session anyway; failing here would
    // throw inside a pagehide handler.
    expect(() => sendLeave('viewer-1')).not.toThrow()
  })
})
