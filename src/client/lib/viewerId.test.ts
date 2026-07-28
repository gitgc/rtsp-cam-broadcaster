import { describe, expect, it } from 'vitest'
import { stableViewerId } from './viewerId.js'

const KEY = 'cluckcam:viewer-id'

/** An in-memory Storage good enough for the two methods this uses. */
function fakeStorage(seed: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(seed))
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size
    },
  } as Storage
}

describe('stableViewerId', () => {
  it('reuses the id already in storage', () => {
    // One browser = one viewer, across reloads and extra tabs.
    const storage = fakeStorage({ [KEY]: 'existing-id' })
    expect(stableViewerId(storage)).toBe('existing-id')
  })

  it('generates and persists an id on first visit', () => {
    const storage = fakeStorage()

    const first = stableViewerId(storage)

    expect(first).toBeTruthy()
    expect(storage.getItem(KEY)).toBe(first)
    expect(stableViewerId(storage)).toBe(first)
  })

  it('gives different browsers different ids', () => {
    expect(stableViewerId(fakeStorage())).not.toBe(stableViewerId(fakeStorage()))
  })

  it('falls back to a per-load id when storage is unavailable', () => {
    // Private mode / blocked storage throws on access; the page must still
    // work, just over-counting slightly.
    const blocked = {
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => {
        throw new Error('SecurityError')
      },
    } as unknown as Storage

    const id = stableViewerId(blocked)

    expect(id).toBeTruthy()
    expect(stableViewerId(blocked)).not.toBe(id) // fresh each call, by design
  })

  it('survives storage being entirely absent', () => {
    expect(stableViewerId(undefined)).toBeTruthy()
  })
})
