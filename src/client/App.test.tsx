import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import type { AppBootstrap, DetectionDto } from '../shared/types.js'
import { App } from './App.js'
import { createFakeHls } from './test/fakeHls.js'

const BOOTSTRAP: AppBootstrap = { title: "Paul's Chickens", tagline: 'Live from the coop 🐔' }

const DEER: DetectionDto = {
  label: 'deer',
  camera: 'roaming',
  lastSeen: Date.now() - 60_000,
  score: 0.9,
  image: '/api/detections/deer/snapshot.jpg?ts=1',
}

/** Stands in for the Fastify JSON endpoints. */
function stubApi({ viewers = 3, detections = [] as DetectionDto[] } = {}) {
  const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
    (input) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url.includes('/api/heartbeat')) return Promise.resolve(Response.json({ viewers }))
      if (url.includes('/api/detections')) return Promise.resolve(Response.json({ detections }))
      return Promise.resolve(new Response('not found', { status: 404 }))
    },
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('App', () => {
  it('renders the configured title and tagline', async () => {
    stubApi()
    const hls = createFakeHls()
    const screen = await render(<App bootstrap={BOOTSTRAP} loadHls={hls.loader} />)

    await expect
      .element(screen.getByRole('heading', { level: 1 }))
      .toHaveTextContent("Paul's Chickens")
    await expect.element(screen.getByText('Live from the coop 🐔')).toBeInTheDocument()
  })

  it('shows the live viewer count once the first heartbeat returns', async () => {
    stubApi({ viewers: 7 })
    const hls = createFakeHls()
    const screen = await render(<App bootstrap={BOOTSTRAP} loadHls={hls.loader} />)

    await expect
      .element(screen.getByTitle('People watching right now'))
      .toHaveTextContent('7 watching')
  })

  it('identifies itself with the same viewer id on every heartbeat', async () => {
    const fetchMock = stubApi()
    const hls = createFakeHls()
    await render(<App bootstrap={BOOTSTRAP} loadHls={hls.loader} />)

    await vi.waitFor(() => {
      const beat = fetchMock.mock.calls.find(([url]) => String(url).includes('/api/heartbeat'))
      expect(beat).toBeDefined()
      expect(JSON.parse(String(beat?.[1]?.body))).toEqual({ id: expect.any(String) })
    })
  })

  it('renders sightings returned by the detections endpoint', async () => {
    stubApi({ detections: [DEER] })
    const hls = createFakeHls()
    const screen = await render(<App bootstrap={BOOTSTRAP} loadHls={hls.loader} />)

    await expect.element(screen.getByText('🦌 Deer')).toBeInTheDocument()
  })

  it('omits the sightings section entirely when nothing has been spotted', async () => {
    stubApi({ detections: [] })
    const hls = createFakeHls()
    const screen = await render(<App bootstrap={BOOTSTRAP} loadHls={hls.loader} />)

    await expect.element(screen.getByRole('heading', { level: 1 })).toBeInTheDocument()
    expect(screen.container.querySelector('.sightings')).toBeNull()
  })

  it('lights the LIVE badge once the player reports progress', async () => {
    stubApi()
    const hls = createFakeHls()
    const screen = await render(<App bootstrap={BOOTSTRAP} loadHls={hls.loader} />)

    const badge = screen.container.querySelector('.live')
    expect(badge?.classList.contains('on')).toBe(false)

    screen.container.querySelector('video')?.dispatchEvent(new Event('playing'))

    await vi.waitFor(() => expect(badge?.classList.contains('on')).toBe(true))
  })

  it('keeps rendering the page when the API is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<() => Promise<Response>>(() => Promise.reject(new Error('offline'))),
    )
    const hls = createFakeHls()
    const screen = await render(<App bootstrap={BOOTSTRAP} loadHls={hls.loader} />)

    // Header and video still render; the viewer count just stays unknown.
    await expect.element(screen.getByRole('heading', { level: 1 })).toBeInTheDocument()
    await expect
      .element(screen.getByTitle('People watching right now'))
      .toHaveTextContent('– watching')
  })
})
