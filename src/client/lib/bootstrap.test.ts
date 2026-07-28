import { afterEach, describe, expect, it } from 'vitest'
import { FALLBACK_BOOTSTRAP, readBootstrap } from './bootstrap.js'

/** Builds a detached document holding the given bootstrap script contents. */
function docWith(scriptBody: string | null): Document {
  const doc = document.implementation.createHTMLDocument('test')
  if (scriptBody !== null) {
    const script = doc.createElement('script')
    script.type = 'application/json'
    script.id = 'app-bootstrap'
    script.textContent = scriptBody
    doc.head.append(script)
  }
  return doc
}

afterEach(() => {
  document.getElementById('app-bootstrap')?.remove()
})

describe('readBootstrap', () => {
  it('reads the config the server templated into the page', () => {
    const doc = docWith('{"title":"Paul\'s Chickens","tagline":"Live from the coop"}')
    expect(readBootstrap(doc)).toEqual({
      title: "Paul's Chickens",
      tagline: 'Live from the coop',
    })
  })

  it('round-trips values the server had to escape for the script tag', () => {
    // The server emits `<` as \u003c so a title can't close the script early.
    const doc = docWith('{"title":"\\u003c/script\\u003e","tagline":"ok"}')
    expect(readBootstrap(doc).title).toBe('</script>')
  })

  it('falls back when the script tag is absent', () => {
    expect(readBootstrap(docWith(null))).toEqual(FALLBACK_BOOTSTRAP)
  })

  it('falls back on malformed JSON rather than blanking the page', () => {
    expect(readBootstrap(docWith('{not json'))).toEqual(FALLBACK_BOOTSTRAP)
  })

  it('fills in individually missing or wrongly-typed fields', () => {
    const doc = docWith('{"title":42}')
    expect(readBootstrap(doc)).toEqual(FALLBACK_BOOTSTRAP)
  })

  it('defaults to the live document', () => {
    const script = document.createElement('script')
    script.type = 'application/json'
    script.id = 'app-bootstrap'
    script.textContent = '{"title":"From document","tagline":"t"}'
    document.head.append(script)

    expect(readBootstrap().title).toBe('From document')
  })
})
