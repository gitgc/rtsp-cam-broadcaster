import './Header.css'

export interface HeaderProps {
  title: string
  /** Video is genuinely progressing — drives the pulsing LIVE dot. */
  isLive: boolean
  /** Live viewer count, or `null` before the first heartbeat lands. */
  viewers: number | null
}

export function Header({ title, isLive, viewers }: HeaderProps) {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="logo" aria-hidden="true">
          🐔
        </span>
        <h1>{title}</h1>
      </div>

      <div className="status">
        {/* <output> carries an implicit role="status", so assistive tech is
            told when the stream goes live without a redundant role attribute. */}
        <output className={isLive ? 'live on' : 'live'} aria-live="polite">
          <span className="dot" aria-hidden="true" />
          <span className="live-label">LIVE</span>
        </output>

        {/* The explicit spaces matter: they're what make this read as
            "3 watching" to a screen reader. Flex containers drop whitespace-only
            nodes between items, so they cost nothing visually. */}
        <div className="viewers" title="People watching right now">
          <span className="eye" aria-hidden="true">
            👁
          </span>{' '}
          <span className="viewers-count">{viewers ?? '–'}</span>{' '}
          <span className="viewers-label">watching</span>
        </div>
      </div>
    </header>
  )
}
