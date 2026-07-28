import { describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import type { DetectionDto } from '../../../shared/types.js'
import { Lightbox } from './Lightbox.js'

const DEER: DetectionDto = {
  label: 'deer',
  camera: 'roaming',
  lastSeen: 1700000000000,
  score: 0.9,
  image: '/api/detections/deer/snapshot.jpg?ts=1',
}

const dialogIn = (container: HTMLElement) => container.querySelector('dialog')

describe('Lightbox', () => {
  it('stays mounted but closed when there is nothing to show', async () => {
    // Kept in the DOM on purpose: closing through the element is what lets the
    // browser hand focus back to whatever opened it.
    const screen = await render(<Lightbox detection={null} onClose={vi.fn<() => void>()} />)

    expect(dialogIn(screen.container)).not.toBeNull()
    expect(dialogIn(screen.container)?.open).toBe(false)
    expect(screen.container.querySelector('.lightbox-img')).toBeNull()
  })

  it('opens as a modal dialog naming the animal', async () => {
    const screen = await render(<Lightbox detection={DEER} onClose={vi.fn<() => void>()} />)

    await vi.waitFor(() => expect(dialogIn(screen.container)?.open).toBe(true))
    await expect.element(screen.getByRole('dialog')).toHaveAttribute('aria-label', '🦌 Deer')
    await expect
      .element(screen.getByRole('img', { name: '🦌 Deer' }))
      .toHaveAttribute('src', DEER.image)
  })

  it('shows when the animal was seen', async () => {
    const screen = await render(<Lightbox detection={DEER} onClose={vi.fn<() => void>()} />)
    await expect
      .element(screen.getByText(new Date(DEER.lastSeen!).toLocaleString()))
      .toBeInTheDocument()
  })

  it('says "spotted recently" when the timestamp is unknown', async () => {
    // Retained Frigate snapshots carry no trustworthy time — see frigate.ts.
    const screen = await render(
      <Lightbox detection={{ ...DEER, lastSeen: null }} onClose={vi.fn<() => void>()} />,
    )
    await expect.element(screen.getByText('spotted recently')).toBeInTheDocument()
  })

  it('closes via the close button', async () => {
    const onClose = vi.fn<() => void>()
    const screen = await render(<Lightbox detection={DEER} onClose={onClose} />)

    await screen.getByRole('button', { name: 'Close' }).click()

    expect(onClose).toHaveBeenCalled()
  })

  it('closes on Escape, handled natively by <dialog>', async () => {
    const onClose = vi.fn<() => void>()
    const screen = await render(<Lightbox detection={DEER} onClose={onClose} />)
    await vi.waitFor(() => expect(dialogIn(screen.container)?.open).toBe(true))

    await userEvent.keyboard('{Escape}')

    await vi.waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('closes on a backdrop click but not on a click inside the content', async () => {
    const onClose = vi.fn<() => void>()
    const screen = await render(<Lightbox detection={DEER} onClose={onClose} />)
    await vi.waitFor(() => expect(dialogIn(screen.container)?.open).toBe(true))

    // Clicking the image must not dismiss — that's the thing you came to look at.
    await screen.getByRole('img', { name: '🦌 Deer' }).click()
    expect(onClose).not.toHaveBeenCalled()

    // A click landing on the dialog element itself is a backdrop click.
    dialogIn(screen.container)?.click()
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('moves focus into the dialog when it opens', async () => {
    const screen = await render(<Lightbox detection={DEER} onClose={vi.fn<() => void>()} />)

    await expect.element(screen.getByRole('button', { name: 'Close' })).toHaveFocus()
  })
})
