/**
 * Presentation for Frigate object labels. The server decides *which* labels are
 * tracked (FRIGATE_LABELS); this only decides how one looks on the page, so an
 * unmapped label degrades to a paw print rather than disappearing.
 */
const LABEL_EMOJI: Readonly<Record<string, string>> = {
  bear: '🐻',
  deer: '🦌',
  dog: '🐕',
  cat: '🐈',
  bird: '🐦',
  raccoon: '🦝',
  fox: '🦊',
  squirrel: '🐿️',
  rabbit: '🐇',
  person: '🧍',
}

const FALLBACK_EMOJI = '🐾'

export function labelEmoji(label: string): string {
  return LABEL_EMOJI[label] ?? FALLBACK_EMOJI
}

/** `deer` -> `Deer`. */
export function labelTitle(label: string): string {
  return label.charAt(0).toUpperCase() + label.slice(1)
}

/** `deer` -> `🦌 Deer`. */
export function labelDisplay(label: string): string {
  return `${labelEmoji(label)} ${labelTitle(label)}`
}
