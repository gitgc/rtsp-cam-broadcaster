import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import type { DetectionDto } from '../../../shared/types.js'
import { UNDATED_LABEL, UNDATED_TITLE } from '../../lib/time.js'
import { SightingCard } from './SightingCard.js'

function detection(overrides: Partial<DetectionDto> = {}): DetectionDto {
  return {
    label: 'deer',
    camera: 'roaming',
    lastSeen: Date.now() - 5 * 60 * 1000,
    score: 0.9,
    image: '/api/detections/deer/snapshot.jpg?ts=1',
    ...overrides,
  }
}

describe('SightingCard', () => {
  it('labels the animal with its emoji and title case name', async () => {
    const screen = await render(
      <SightingCard detection={detection()} onSelect={vi.fn<(d: DetectionDto) => void>()} />,
    )
    await expect.element(screen.getByText('🦌 Deer')).toBeInTheDocument()
  })

  it('falls back to a paw print for a label it has no emoji for', async () => {
    const screen = await render(
      <SightingCard
        detection={detection({ label: 'coyote' })}
        onSelect={vi.fn<(d: DetectionDto) => void>()}
      />,
    )
    await expect.element(screen.getByText('🐾 Coyote')).toBeInTheDocument()
  })

  it('shows how long ago the animal was seen', async () => {
    const screen = await render(
      <SightingCard detection={detection()} onSelect={vi.fn<(d: DetectionDto) => void>()} />,
    )
    await expect.element(screen.getByText('5m ago')).toBeInTheDocument()
  })

  it('does not imply recency for a snapshot of unknown age', async () => {
    // A retained Frigate snapshot can be days old. Captioning it "recently"
    // under a "Recently spotted" heading would be a lie.
    const screen = await render(
      <SightingCard
        detection={detection({ lastSeen: null })}
        onSelect={vi.fn<(d: DetectionDto) => void>()}
      />,
    )

    await expect.element(screen.getByText(UNDATED_LABEL)).toBeInTheDocument()
    expect(screen.container.textContent).not.toMatch(/recent|ago/)
    // No <time>: there is no machine-readable value to put in it.
    expect(screen.container.querySelector('time')).toBeNull()
    expect(screen.container.querySelector('.sighting-time')?.getAttribute('title')).toBe(
      UNDATED_TITLE,
    )
  })

  it('uses a real <time> element when the sighting is dated', async () => {
    const at = Date.UTC(2026, 0, 15, 12, 0, 0)
    const screen = await render(
      <SightingCard
        detection={detection({ lastSeen: at })}
        onSelect={vi.fn<(d: DetectionDto) => void>()}
      />,
    )

    expect(screen.container.querySelector('time')?.getAttribute('datetime')).toBe(
      new Date(at).toISOString(),
    )
  })

  it('renders the snapshot with its cache-busted URL', async () => {
    const screen = await render(
      <SightingCard detection={detection()} onSelect={vi.fn<(d: DetectionDto) => void>()} />,
    )
    const img = screen.container.querySelector('img')
    expect(img?.getAttribute('src')).toBe('/api/detections/deer/snapshot.jpg?ts=1')
    // Decorative: the caption right below already names the animal.
    expect(img?.getAttribute('alt')).toBe('')
    expect(img?.getAttribute('loading')).toBe('lazy')
  })

  it('is a real button, so it is reachable and operable by keyboard', async () => {
    const onSelect = vi.fn<(d: DetectionDto) => void>()
    const item = detection()
    const screen = await render(<SightingCard detection={item} onSelect={onSelect} />)

    const button = screen.getByRole('button', { name: 'Enlarge Deer snapshot' })
    await button.click()

    expect(onSelect).toHaveBeenCalledExactlyOnceWith(item)
  })
})
