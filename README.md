# ACS Chennai / VirtualOffice React Website

This is a modern React (Vite) site for ACS Chennai / VirtualOffice, featuring a technical company profile, projects, team, careers, blog, and a contact form.

## Local Development

1. **Install dependencies:**
   ```bash
   npm install
   ```
2. **Run the development server:**
   ```bash
   npm run dev
   ```

## Production Build

```bash
npm run build
```

## Deploy

- Deploy the `dist/` folder to any static host (Vercel, Netlify, GitHub Pages, etc).
- For GitHub Pages, the app uses `HashRouter` and `vite.config.js` sets `base: "/ACS_Chennai/"`. Adjust base if your repo name differs.
- You can publish via `git subtree` or tools like `gh-pages`.

## Contact Form

- Register for a free endpoint at [formspree.io](https://formspree.io/).
- Create a `.env` file based on `.env.example` and set:
  - `VITE_FORMSPREE_ID=yourFormID`
- Optionally set a hero background video/poster:
  - `VITE_HERO_VIDEO_URL=https://.../construction.mp4`
  - `VITE_HERO_POSTER_URL=https://.../poster.jpg`

---

*ACS Chennai — Building Tomorrow, Remotely and Reliably.*
