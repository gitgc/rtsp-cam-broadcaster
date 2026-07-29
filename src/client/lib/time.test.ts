import { describe, expect, it } from 'vitest'
import { absoluteTime, relativeTime, UNDATED_LABEL } from './time.js'

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0)
const ago = (ms: number) => relativeTime(NOW - ms, NOW)

describe('relativeTime', () => {
  it('counts in seconds under a minute', () => {
    expect(ago(0)).toBe('0s ago')
    expect(ago(59_000)).toBe('59s ago')
  })

  it('rolls up to minutes, hours, then days', () => {
    expect(ago(60_000)).toBe('1m ago')
    expect(ago(59 * 60_000)).toBe('59m ago')
    expect(ago(60 * 60_000)).toBe('1h ago')
    expect(ago(23 * 60 * 60_000)).toBe('23h ago')
    expect(ago(24 * 60 * 60_000)).toBe('1d ago')
    expect(ago(10 * 24 * 60 * 60_000)).toBe('10d ago')
  })

  it('does not claim recency for a snapshot of unknown age', () => {
    // Retained Frigate snapshots have no trustworthy time — see frigate.ts.
    // They can be days old, so the label must not imply they are fresh.
    for (const unknown of [null, 0, undefined]) {
      expect(relativeTime(unknown, NOW)).toBe(UNDATED_LABEL)
      expect(relativeTime(unknown, NOW)).not.toMatch(/recent|ago/)
    }
  })

  it('never shows a negative age when a clock is skewed ahead', () => {
    expect(relativeTime(NOW + 30_000, NOW)).toBe('0s ago')
  })
})

describe('absoluteTime', () => {
  it('is undefined for an unknown timestamp, so no tooltip is rendered', () => {
    expect(absoluteTime(null)).toBeUndefined()
    expect(absoluteTime(0)).toBeUndefined()
  })

  it('formats a real timestamp for the viewer’s locale', () => {
    expect(absoluteTime(NOW)).toBe(new Date(NOW).toLocaleString())
  })
})
