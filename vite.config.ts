import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import type { AppBootstrap } from './src/shared/types.js'

/** Stand-ins for what Fastify injects in production. Only used by `vite dev`. */
const DEV_BOOTSTRAP: AppBootstrap = {
  title: "Paul's Chickens (dev)",
  tagline: 'Live from the coop 🐔',
}

/**
 * The built `index.html` intentionally ships `{{TITLE}}`/`{{TAGLINE}}`/
 * `{{BOOTSTRAP}}` placeholders — the server fills them at boot from env config
 * (see `src/server/server.ts`). `vite dev` serves the file without ever going
 * through Fastify, so fill them here too or the dev page renders the literal
 * mustaches.
 */
function devTemplateDefaults(): Plugin {
  return {
    name: 'cluckcam:dev-template-defaults',
    apply: 'serve',
    transformIndexHtml(html) {
      return html
        .replaceAll('{{TITLE}}', DEV_BOOTSTRAP.title)
        .replaceAll('{{TAGLINE}}', DEV_BOOTSTRAP.tagline)
        .replaceAll('{{BOOTSTRAP}}', JSON.stringify(DEV_BOOTSTRAP))
    },
  }
}

export default defineConfig({
  root: 'src/client',
  plugins: [react(), devTemplateDefaults()],
  build: {
    outDir: '../../dist/client',
    emptyOutDir: true,
    // Filenames are content-hashed, which is what lets the server serve
    // /assets/* as immutable — see the cache headers in src/server/server.ts.
    assetsDir: 'assets',
    sourcemap: true,
  },
  server: {
    port: 5173,
    // `npm run dev` runs Fastify on 8080; proxy the live stream and APIs to it
    // so the dev page shows real video instead of a permanently spinning overlay.
    //
    // These prefixes are reserved: Vite serves source modules at their path
    // under `root`, so a `src/client/api/` folder would be requested as
    // `/api/…` and get proxied into Fastify instead of compiled. Don't create
    // client directories named after a prefix listed here.
    proxy: {
      '/api': 'http://127.0.0.1:8080',
      '/hls': 'http://127.0.0.1:8080',
    },
  },
})
