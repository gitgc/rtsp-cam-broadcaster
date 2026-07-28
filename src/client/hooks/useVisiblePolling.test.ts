import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from 'vitest-browser-react'
import { useVisiblePolling } from './useVisiblePolling.js'

const TICK_MS = 20
const idle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** `document.hidden` is read-only, so shadow its getter for the test. */
function defineHidden(hidden: boolean): void {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
}

/** Change visibility and fire the event the browser would. */
function setHidden(hidden: boolean): void {
  defineHidden(hidden)
  document.dispatchEvent(new Event('visibilitychange'))
}

beforeEach(() => {
  defineHidden(false) // don't depend on the runner's real visibility
})

afterEach(() => {
  Reflect.deleteProperty(document, 'hidden')
})

describe('useVisiblePolling', () => {
  it('runs the task immediately, without waiting a full interval', async () => {
    const task = vi.fn<() => void>()
    await renderHook(() => useVisiblePolling(task, 60_000))

    expect(task).toHaveBeenCalledTimes(1)
  })

  it('keeps running it on the interval', async () => {
    const task = vi.fn<() => void>()
    await renderHook(() => useVisiblePolling(task, TICK_MS))

    await vi.waitFor(() => expect(task.mock.calls.length).toBeGreaterThanOrEqual(3))
  })

  it('skips ticks while the tab is in the background', async () => {
    defineHidden(true)
    const task = vi.fn<() => void>()
    await renderHook(() => useVisiblePolling(task, TICK_MS))

    await idle(TICK_MS * 6)

    // A backgrounded tab isn't watching: polling from it would burn battery and
    // inflate the viewer count.
    expect(task).not.toHaveBeenCalled()
  })

  it('catches up the moment the tab comes back to the foreground', async () => {
    defineHidden(true)
    const task = vi.fn<() => void>()
    await renderHook(() => useVisiblePolling(task, 60_000))
    expect(task).not.toHaveBeenCalled()

    setHidden(false)

    // Refreshes on the visibility event, not on the next (distant) interval.
    await vi.waitFor(() => expect(task).toHaveBeenCalledTimes(1))
  })

  it('swaps in the latest task without restarting the timer', async () => {
    const first = vi.fn<() => void>()
    const second = vi.fn<() => void>()
    let task: () => void = first

    const view = await renderHook(() => useVisiblePolling(task, 60_000))
    expect(first).toHaveBeenCalledTimes(1)

    task = second
    await view.rerender()
    // A restarted effect would fire its own immediate run right here.
    expect(second).not.toHaveBeenCalled()

    setHidden(false)

    await vi.waitFor(() => expect(second).toHaveBeenCalledTimes(1))
    expect(first).toHaveBeenCalledTimes(1) // the stale closure is never called again
  })

  it('stops polling once the component unmounts', async () => {
    const task = vi.fn<() => void>()
    const view = await renderHook(() => useVisiblePolling(task, TICK_MS))

    await vi.waitFor(() => expect(task).toHaveBeenCalled())
    await view.unmount()
    const callsAtUnmount = task.mock.calls.length

    await idle(TICK_MS * 6)
    expect(task.mock.calls.length).toBe(callsAtUnmount)
  })

  it('detaches the visibility listener on unmount', async () => {
    const task = vi.fn<() => void>()
    const view = await renderHook(() => useVisiblePolling(task, 60_000))
    await view.unmount()

    setHidden(false)

    await idle(TICK_MS)
    expect(task).toHaveBeenCalledTimes(1) // just the one run from mounting
  })
})
