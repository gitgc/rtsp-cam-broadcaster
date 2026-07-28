import { describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import type { DetectionDto } from '../../../shared/types.js'
import { RecentlySpotted } from './RecentlySpotted.js'

const DEER: DetectionDto = {
  label: 'deer',
  camera: 'roaming',
  lastSeen: 1700000000000,
  score: 0.9,
  image: '/api/detections/deer/snapshot.jpg?ts=1',
}

const FOX: DetectionDto = {
  label: 'fox',
  camera: 'roaming',
  lastSeen: 1700000005000,
  score: 0.7,
  image: '/api/detections/fox/snapshot.jpg?ts=2',
}

describe('RecentlySpotted', () => {
  it('renders nothing at all when there are no sightings', async () => {
    const screen = await render(<RecentlySpotted detections={[]} />)
    // An unconfigured or quiet camera should leave no empty shell behind.
    expect(screen.container.innerHTML).toBe('')
  })

  it('renders one card per sighting, in the order given', async () => {
    const screen = await render(<RecentlySpotted detections={[FOX, DEER]} />)

    await expect
      .element(screen.getByRole('heading', { level: 2 }))
      .toHaveTextContent('Recently spotted')
    const names = [...screen.container.querySelectorAll('.sighting-name')].map((n) => n.textContent)
    expect(names).toEqual(['🦊 Fox', '🦌 Deer'])
  })

  it('opens a labelled dialog for the sighting that was clicked', async () => {
    const screen = await render(<RecentlySpotted detections={[FOX, DEER]} />)

    // The <dialog> is always mounted; it just isn't open until a card is used.
    expect(screen.container.querySelector('dialog')?.open).toBe(false)
    await screen.getByRole('button', { name: 'Enlarge Deer snapshot' }).click()

    // A native modal <dialog> — so aria-modal, the focus trap and background
    // inertness are the browser's job, not ours.
    await expect.element(screen.getByRole('dialog')).toHaveAttribute('aria-label', '🦌 Deer')
    expect(screen.container.querySelector('dialog')?.open).toBe(true)
    // The clicked card's snapshot, not the other one.
    expect(screen.container.querySelector('.lightbox-img')?.getAttribute('src')).toBe(DEER.image)
  })

  it('moves focus into the dialog and back to the card on close', async () => {
    const screen = await render(<RecentlySpotted detections={[DEER]} />)
    const card = screen.getByRole('button', { name: 'Enlarge Deer snapshot' })

    await card.click()
    const close = screen.getByRole('button', { name: 'Close' })
    await expect.element(close).toHaveFocus()

    await close.click()
    await expect.element(card).toHaveFocus()
  })

  it('closes on Escape', async () => {
    const screen = await render(<RecentlySpotted detections={[DEER]} />)
    await screen.getByRole('button', { name: 'Enlarge Deer snapshot' }).click()
    await expect.element(screen.getByRole('dialog')).toBeInTheDocument()

    await userEvent.keyboard('{Escape}')

    await vi.waitFor(() => expect(screen.container.querySelector('dialog')?.open).toBe(false))
  })
})
