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
function spaFallback404() {
  return {
    name: 'acs-spa-fallback-404',
    apply: 'build',
    closeBundle() {
      const dir = resolve(__dirname, 'dist')
      const index = resolve(dir, 'index.html')
      if (!existsSync(index)) {
        throw new Error('[spaFallback404] dist/index.html missing — cannot emit 404.html')
      }
      copyFileSync(index, resolve(dir, '404.html'))
    },
  }
}

// https://vitejs.dev/config/
export default defineConfig(({ command }) => ({
  plugins: [react(), spaFallback404()],
  base: '/',
}))
