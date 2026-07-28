import { describe, expect, it } from 'vitest'
import { labelDisplay, labelEmoji, labelTitle } from './labels.js'

describe('label presentation', () => {
  it('maps every label in the server default set to its own emoji', () => {
    // Mirrors DEFAULT_LABELS in src/server/config.ts — if a label is added
    // there without an emoji here it silently degrades to a paw print.
    const defaults = [
      'bear',
      'deer',
      'dog',
      'cat',
      'bird',
      'raccoon',
      'fox',
      'squirrel',
      'rabbit',
      'person',
    ]
    const emoji = defaults.map(labelEmoji)

    expect(emoji).not.toContain('🐾')
    expect(new Set(emoji).size).toBe(defaults.length) // no duplicates to confuse
  })

  it('degrades to a paw print for a label it has never seen', () => {
    // FRIGATE_LABELS is user-configurable, so unknown labels are expected.
    expect(labelEmoji('coyote')).toBe('🐾')
  })

  it('title-cases the label for display', () => {
    expect(labelTitle('deer')).toBe('Deer')
    expect(labelTitle('raccoon')).toBe('Raccoon')
  })

  it('combines emoji and name for the caption', () => {
    expect(labelDisplay('fox')).toBe('🦊 Fox')
    expect(labelDisplay('coyote')).toBe('🐾 Coyote')
  })

  it('does not crash on an empty label', () => {
    expect(labelTitle('')).toBe('')
    expect(labelDisplay('')).toBe('🐾 ')
  })
})
