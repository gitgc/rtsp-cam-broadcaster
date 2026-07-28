import type { AppBootstrap } from '../../shared/types.js'

/**
 * Used when the bootstrap script tag is missing or unparseable — e.g. a
 * component test that renders `<App />` in isolation, or `vite preview` on an
 * un-templated build. The page still renders; it just isn't branded.
 */
export const FALLBACK_BOOTSTRAP: AppBootstrap = {
  title: 'Live camera',
  tagline: 'Live stream',
}

const ELEMENT_ID = 'app-bootstrap'

/**
 * Reads the JSON the server templated into `<script id="app-bootstrap">`.
 * Never throws — a broken blob degrades to {@link FALLBACK_BOOTSTRAP}.
 */
export function readBootstrap(doc: Document = document): AppBootstrap {
  const raw = doc.getElementById(ELEMENT_ID)?.textContent?.trim()
  if (!raw) return FALLBACK_BOOTSTRAP

  try {
    const parsed = JSON.parse(raw) as Partial<AppBootstrap>
    return {
      title: typeof parsed.title === 'string' ? parsed.title : FALLBACK_BOOTSTRAP.title,
      tagline: typeof parsed.tagline === 'string' ? parsed.tagline : FALLBACK_BOOTSTRAP.tagline,
    }
  } catch {
    return FALLBACK_BOOTSTRAP
  }
}
