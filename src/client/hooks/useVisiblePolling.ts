import { useEffect, useRef } from 'react'

/**
 * Runs `task` immediately, then every `intervalMs` — but only while the tab is
 * in the foreground, and again the moment it comes back. A backgrounded tab
 * isn't watching anything, so polling from it just burns the viewer's battery
 * and inflates the presence count.
 *
 * `task` may be a fresh closure each render; it is read through a ref so
 * changing it never restarts the timer.
 */
export function useVisiblePolling(task: () => void, intervalMs: number): void {
  const taskRef = useRef(task)

  useEffect(() => {
    taskRef.current = task
  }, [task])

  useEffect(() => {
    const run = (): void => {
      if (!document.hidden) taskRef.current()
    }

    run()
    const timer = setInterval(run, intervalMs)
    document.addEventListener('visibilitychange', run)

    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', run)
    }
  }, [intervalMs])
}
