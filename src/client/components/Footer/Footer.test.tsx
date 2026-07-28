import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-react'
import { Footer } from './Footer.js'

describe('Footer', () => {
  it('links to the project repo, safely, in a new tab', async () => {
    const screen = await render(<Footer />)
    const link = screen.getByRole('link', { name: 'GitHub' })

    await expect.element(link).toHaveAttribute('target', '_blank')
    // Without noopener the opened tab can reach back via window.opener.
    await expect.element(link).toHaveAttribute('rel', 'noopener noreferrer')
    await expect
      .element(link)
      .toHaveAttribute('href', 'https://github.com/gitgc/rtsp-cam-broadcaster')
  })

  it('credits the author', async () => {
    const screen = await render(<Footer />)
    await expect.element(screen.getByText('Made by Gio Coia')).toBeInTheDocument()
  })
})
