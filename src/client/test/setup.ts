// Registers `page.render` and unmounts any component left over from the
// previous test, so each case starts from a clean document.
import 'vitest-browser-react'

// The app's tokens and font stack. Components import only their own stylesheet,
// so without this the browser falls back to Times at default metrics — which
// silently makes any size- or layout-sensitive assertion measure something the
// real page never renders.
import '../styles/global.css'
