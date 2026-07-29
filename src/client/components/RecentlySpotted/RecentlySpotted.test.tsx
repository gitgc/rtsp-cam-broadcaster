import { describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import type { DetectionDto } from '../../../shared/types.js'
import { MAX_RENDERED_SIGHTINGS, RecentlySpotted } from './RecentlySpotted.js'

const MINUTE = 60_000
const NOW = Date.now()

function sighting(overrides: Partial<DetectionDto> = {}): DetectionDto {
  const id = overrides.id ?? 1
  const label = overrides.label ?? 'deer'
  return {
    id,
    label,
    camera: 'roaming',
    seenAt: NOW - MINUTE,
    score: 0.9,
    image: `/api/detections/${label}/${id}/snapshot.jpg`,
    ...overrides,
  }
}

const DEER = sighting({ id: 1, label: 'deer', seenAt: NOW - 5 * MINUTE })
const FOX = sighting({ id: 2, label: 'fox', seenAt: NOW - 2 * MINUTE })

/** Card accessible names include the time, since one animal has many cards. */
const cardNamed = (label: string, when: string) => `Enlarge ${label} snapshot (${when})`

const namesIn = (container: HTMLElement) =>
  [...container.querySelectorAll('.sighting-name')].map((n) => n.textContent)

const timesIn = (container: HTMLElement) =>
  [...container.querySelectorAll('.sighting-time')].map((n) => n.textContent)

const cardsIn = (container: HTMLElement) => container.querySelectorAll('.sighting')

/** The nine labels the server tracks by default. */
const LABELS = ['deer', 'fox', 'cat', 'dog', 'bird', 'raccoon', 'squirrel', 'rabbit', 'bear']

/**
 * `count` sightings ordered newest-first, one minute apart, cycling through the
 * labels — i.e. what `GET /api/detections` returns. The n-th entry reads as
 * "{n+1}m ago", which is what lets the tests name exactly which cards survived
 * the cap.
 */
function sightingHistory(count: number): DetectionDto[] {
  return Array.from({ length: count }, (_, i) =>
    sighting({
      id: count - i,
      label: LABELS[i % LABELS.length]!,
      seenAt: NOW - (i + 1) * MINUTE,
    }),
  )
}

const minutesAgo = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `${from + i}m ago`)

describe('RecentlySpotted', () => {
  it('caps the grid at 18 cards', () => {
    // Pinned to the literal on purpose: every other test here is written
    // against the constant, so without this one a change to the number would
    // pass silently instead of being a deliberate decision.
    expect(MAX_RENDERED_SIGHTINGS).toBe(18)
  })

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
    expect(namesIn(screen.container)).toEqual(['🦊 Fox', '🦌 Deer'])
  })

  it(`renders at most ${MAX_RENDERED_SIGHTINGS} cards even with a full store`, async () => {
    // 9 labels x 5 snapshots = the most the server can ever hold.
    const stored = sightingHistory(45)
    const screen = await render(<RecentlySpotted detections={stored} />)

    expect(stored).toHaveLength(45)
    expect(cardsIn(screen.container)).toHaveLength(MAX_RENDERED_SIGHTINGS)
  })

  it('keeps the most recent sightings and drops the rest', async () => {
    const screen = await render(<RecentlySpotted detections={sightingHistory(45)} />)

    // Exactly 1m..18m ago — the newest 18, in order. Nothing older leaked in.
    expect(timesIn(screen.container)).toEqual(minutesAgo(1, MAX_RENDERED_SIGHTINGS))
  })

  it('does not fetch images for the sightings it drops', async () => {
    // The cap exists to bound bytes as much as scrolling, so the extra 27
    // snapshots must not appear in the DOM at all.
    const stored = sightingHistory(45)
    const screen = await render(<RecentlySpotted detections={stored} />)

    const rendered = [...screen.container.querySelectorAll('.sighting img')].map((i) =>
      i.getAttribute('src'),
    )
    expect(rendered).toEqual(stored.slice(0, MAX_RENDERED_SIGHTINGS).map((d) => d.image))
    for (const dropped of stored.slice(MAX_RENDERED_SIGHTINGS)) {
      expect(rendered).not.toContain(dropped.image)
    }
  })

  it('renders everything when the store holds fewer than the cap', async () => {
    const screen = await render(<RecentlySpotted detections={sightingHistory(7)} />)
    expect(cardsIn(screen.container)).toHaveLength(7)
  })

  it(`renders all ${MAX_RENDERED_SIGHTINGS} when the store holds exactly the cap`, async () => {
    const screen = await render(
      <RecentlySpotted detections={sightingHistory(MAX_RENDERED_SIGHTINGS)} />,
    )

    expect(cardsIn(screen.container)).toHaveLength(MAX_RENDERED_SIGHTINGS)
    expect(timesIn(screen.container)).toEqual(minutesAgo(1, MAX_RENDERED_SIGHTINGS))
  })

  it('pushes the oldest visible card out when a newer sighting arrives', async () => {
    const stored = sightingHistory(45)
    const screen = await render(<RecentlySpotted detections={stored} />)
    expect(timesIn(screen.container).at(-1)).toBe(`${MAX_RENDERED_SIGHTINGS}m ago`)

    // A fresh sighting arrives at the head, as the next poll would deliver it.
    const fresher = sighting({ id: 46, label: 'fox', seenAt: NOW - 10_000 })
    await screen.rerender(<RecentlySpotted detections={[fresher, ...stored]} />)

    expect(cardsIn(screen.container)).toHaveLength(MAX_RENDERED_SIGHTINGS)
    expect(timesIn(screen.container)[0]).toBe('10s ago')
    // 18m ago fell off the end to make room.
    expect(timesIn(screen.container)).not.toContain(`${MAX_RENDERED_SIGHTINGS}m ago`)
  })

  it('keeps every card the same height, even with a long label', async () => {
    // Regression: a caption that wrapped made its card taller, and the grid
    // stretched the whole row to match — leaving a strip of bare panel
    // background above the caption on every other card.
    const long = ['squirrel', 'license_plate', 'motorcycle', 'package', 'raccoon', 'deer'].map(
      (label, i) => sighting({ id: 10 - i, label, seenAt: NOW - (i + 1) * 13 * MINUTE }),
    )
    const screen = await render(<RecentlySpotted detections={long} />)

    // Pin the columns to the production floor (`minmax(150px, 1fr)`), which is
    // the tightest the real grid ever gets — six across on a desktop.
    const grid = screen.container.querySelector<HTMLElement>('.sightings-grid')!
    grid.style.gridTemplateColumns = 'repeat(3, 150px)'

    const cards = [...screen.container.querySelectorAll('.sighting')]
    const heights = new Set(cards.map((c) => Math.round(c.getBoundingClientRect().height)))
    expect(heights.size).toBe(1)

    for (const card of cards) {
      const name = card.querySelector<HTMLElement>('.sighting-name')!
      const lineHeight = Number.parseFloat(getComputedStyle(name).fontSize) * 1.8
      expect(name.getBoundingClientRect().height).toBeLessThan(lineHeight) // one line

      // Nothing but the 1px borders left uncovered by the image + caption.
      const covered =
        card.querySelector('img')!.getBoundingClientRect().height +
        card.querySelector('.sighting-caption')!.getBoundingClientRect().height
      expect(card.getBoundingClientRect().height - covered).toBeLessThanOrEqual(2)
    }
  })

  it('dates every card — the server never sends undated sightings', async () => {
    const screen = await render(<RecentlySpotted detections={sightingHistory(12)} />)

    // Retained snapshots are dropped server-side, so there is no "unknown age"
    // state left to render.
    for (const time of timesIn(screen.container)) {
      expect(time).toMatch(/^\d+[smhd] ago$/)
    }
    expect(screen.container.querySelectorAll('time')).toHaveLength(12)
  })

  it('shows every stored snapshot of the same animal, not just the newest', async () => {
    // The server keeps several snapshots per label, so the grid repeats labels.
    const deerHistory = [
      sighting({ id: 5, label: 'deer', seenAt: NOW - 1 * MINUTE }),
      sighting({ id: 4, label: 'deer', seenAt: NOW - 2 * MINUTE }),
      sighting({ id: 3, label: 'deer', seenAt: NOW - 3 * MINUTE }),
    ]
    const screen = await render(<RecentlySpotted detections={deerHistory} />)

    expect(screen.container.querySelectorAll('.sighting')).toHaveLength(3)
    expect(namesIn(screen.container)).toEqual(['🦌 Deer', '🦌 Deer', '🦌 Deer'])
    // Each card carries its own snapshot, keyed by id.
    expect(
      [...screen.container.querySelectorAll('.sighting img')].map((i) => i.getAttribute('src')),
    ).toEqual([
      '/api/detections/deer/5/snapshot.jpg',
      '/api/detections/deer/4/snapshot.jpg',
      '/api/detections/deer/3/snapshot.jpg',
    ])
  })

  it('keeps each repeated card individually addressable', async () => {
    // Five identical "Enlarge Deer snapshot" buttons would be unusable with a
    // screen reader, so the time is part of the accessible name.
    const deerHistory = [
      sighting({ id: 5, label: 'deer', seenAt: NOW - 1 * MINUTE }),
      sighting({ id: 4, label: 'deer', seenAt: NOW - 9 * MINUTE }),
    ]
    const screen = await render(<RecentlySpotted detections={deerHistory} />)

    await expect
      .element(screen.getByRole('button', { name: cardNamed('Deer', '1m ago') }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('button', { name: cardNamed('Deer', '9m ago') }))
      .toBeInTheDocument()
  })

  it('opens the clicked snapshot, not another of the same animal', async () => {
    const older = sighting({ id: 3, label: 'deer', seenAt: NOW - 30 * MINUTE })
    const screen = await render(<RecentlySpotted detections={[DEER, older]} />)

    // The <dialog> is always mounted; it just isn't open until a card is used.
    expect(screen.container.querySelector('dialog')?.open).toBe(false)
    await screen.getByRole('button', { name: cardNamed('Deer', '30m ago') }).click()

    expect(screen.container.querySelector('dialog')?.open).toBe(true)
    expect(screen.container.querySelector('.lightbox-img')?.getAttribute('src')).toBe(older.image)
  })

  it('labels the dialog with the animal it is showing', async () => {
    const screen = await render(<RecentlySpotted detections={[FOX, DEER]} />)

    await screen.getByRole('button', { name: cardNamed('Deer', '5m ago') }).click()

    // A native modal <dialog> — so aria-modal, the focus trap and background
    // inertness are the browser's job, not ours.
    await expect.element(screen.getByRole('dialog')).toHaveAttribute('aria-label', '🦌 Deer')
    expect(screen.container.querySelector('.lightbox-img')?.getAttribute('src')).toBe(DEER.image)
  })

  it('moves focus into the dialog and back to the card on close', async () => {
    const screen = await render(<RecentlySpotted detections={[DEER]} />)
    const card = screen.getByRole('button', { name: cardNamed('Deer', '5m ago') })

    await card.click()
    const close = screen.getByRole('button', { name: 'Close' })
    await expect.element(close).toHaveFocus()

    await close.click()
    await expect.element(card).toHaveFocus()
  })

  it('closes on Escape', async () => {
    const screen = await render(<RecentlySpotted detections={[DEER]} />)
    await screen.getByRole('button', { name: cardNamed('Deer', '5m ago') }).click()
    await expect.element(screen.getByRole('dialog')).toBeInTheDocument()

    await userEvent.keyboard('{Escape}')

    await vi.waitFor(() => expect(screen.container.querySelector('dialog')?.open).toBe(false))
  })
})
