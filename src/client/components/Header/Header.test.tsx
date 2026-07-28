import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-react'
import { Header } from './Header.js'

const VIEWERS = 'People watching right now'

describe('Header', () => {
  it('renders the stream title as the page heading', async () => {
    const screen = await render(<Header title="Paul's Chickens" isLive={false} viewers={null} />)
    await expect
      .element(screen.getByRole('heading', { level: 1 }))
      .toHaveTextContent("Paul's Chickens")
  })

  it('shows a dash until the first heartbeat lands', async () => {
    const screen = await render(<Header title="Cam" isLive={false} viewers={null} />)
    await expect.element(screen.getByTitle(VIEWERS)).toHaveTextContent('– watching')
  })

  it('shows the viewer count once it is known — including zero', async () => {
    const screen = await render(<Header title="Cam" isLive viewers={0} />)
    await expect.element(screen.getByTitle(VIEWERS)).toHaveTextContent('0 watching')

    await screen.rerender(<Header title="Cam" isLive viewers={42} />)
    await expect.element(screen.getByTitle(VIEWERS)).toHaveTextContent('42 watching')
  })

  it('lights the LIVE badge only while playback is progressing', async () => {
    const screen = await render(<Header title="Cam" isLive={false} viewers={1} />)
    const badge = screen.getByRole('status')
    await expect.element(badge).not.toHaveClass('on')

    await screen.rerender(<Header title="Cam" isLive viewers={1} />)
    await expect.element(badge).toHaveClass('on')
  })

  it('announces the LIVE badge politely to assistive tech', async () => {
    const screen = await render(<Header title="Cam" isLive viewers={1} />)
    await expect.element(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite')
  })
})
