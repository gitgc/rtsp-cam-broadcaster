import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import type { DetectionDto } from '../../../shared/types.js'
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

  it('says "recently" when the snapshot has no known timestamp', async () => {
    const screen = await render(
      <SightingCard
        detection={detection({ lastSeen: null })}
        onSelect={vi.fn<(d: DetectionDto) => void>()}
      />,
    )
    await expect.element(screen.getByText('recently')).toBeInTheDocument()
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
