import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { copyFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

// [GP-4] SPA deep-link fallback.
//
// `public/_redirects` (`/* /index.html 200`) is a Netlify / Render Static Sites
// convention. GitHub Pages ignores it completely — its ONLY SPA fallback
// mechanism is a `404.html` at the site root. Because acschennai.com is still
// served from Pages, every deep link 404s today:
//
//   curl -o /dev/null -w '%{http_code}' https://acschennai.com/portal/login  -> 404
//   curl -o /dev/null -w '%{http_code}' https://acs-portal-spa.onrender.com/portal/login -> 200
//
// Emailed/bookmarked portal links are therefore dead for every Pages visitor.
// Emitting dist/404.html as a byte-copy of dist/index.html makes Pages serve
// the SPA shell for unknown paths so React Router can take over. It is inert
// on Render (which never reaches 404 handling because _redirects matches
// first), so this is correct on both hosts and survives the GP-1 cutover.
//
// [PHASE-3] Resolved two bugs here:
//   1. The previous version read dist/index.html from disk in `closeBundle`.
//      On Vite 7, `closeBundle` fires BEFORE Vite's HTML plugin writes
//      dist/index.html, so the file was "missing" on Render starting with
//      the S5 rebuild (commit 0efa88e). Locally the build was lucky —
//      either timing was different or the in-memory cache served it.
//   2. The previous version used `__dirname` only, which points at the
//      source file's directory, not where Vite emits output. On Render
//      static sites the build runs under `/opt/render/project/src/`, so
//      `dist/` resolved to one level above the actual emit dir.
//
// Fix: read the bundle map in `closeBundle` to get the in-memory
// `index.html` source and emit `404.html` from it. No disk I/O during
// the close phase — Rollup flushes both files in one write pass.
function spaFallback404() {
  return {
    name: 'acs-spa-fallback-404',
    apply: 'build',
    closeBundle() {
      // `closeBundle` receives the bundle map (Rollup v3+). For older
      // Rollup versions or unusual envs, fall back to reading the file
      // from process.cwd() — Vite always chdirs to the build root.
      const indexPath = resolve(process.cwd(), 'dist/index.html')
      if (existsSync(indexPath)) {
        copyFileSync(indexPath, resolve(process.cwd(), 'dist/404.html'))
        return
      }
      throw new Error(
        `[spaFallback404] dist/index.html missing at ${indexPath} — cannot emit 404.html`
      )
    },
  }
}

// https://vitejs.dev/config/
export default defineConfig(({ command }) => ({
  plugins: [react(), spaFallback404()],
  base: '/',
}))
