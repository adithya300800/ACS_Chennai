# Hosting Cutover: GitHub Pages → Render Static Site

**Goal:** move `acschennai.com` (and `www.acschennai.com`) off GitHub Pages and
onto the existing Render static site `acs-portal-spa`, then make the
`ACS_Chennai` repo private — all without taking production offline.

**Owner:** anyone with Render dashboard + DNS access and the ability to
toggle GitHub repo visibility.

**Estimated downtime:** 0 minutes (DNS cutover only; both stacks are
pre-built and reachable during the migration).

---

## 0. Preconditions (verified — do these checks once before starting)

- [x] Render static site `acs-portal-spa` exists and serves the current
      bundle at https://acs-portal-spa.onrender.com.
- [x] `public/_redirects` exists and is referenced by the Render build
      (`/* /index.html 200`); deep link `/portal/login` returns 200 on
      Render and 404 on Pages.
- [x] `VITE_API_URL` on the Render static site is already wired to
      `https://acs-chennai.onrender.com`.
- [x] Backend CORS already permits **both** `https://acschennai.com` and
      `https://acs-portal-spa.onrender.com` (verified by OPTIONS
      preflight).
- [x] `render.yaml` at repo root declares both Render services and matches
      the live dashboard config.
- [ ] **Before you start:** from a clean shell, run
      `curl -sI https://acschennai.com/portal/login | head -1` and confirm
      it currently returns `HTTP/2 200` (Pages) or `404` (if Pages is
      already serving the rewritten bundle). Record the result; you'll
      compare against it in step 4.

> **Why this order matters.** If you flip the repo private before DNS
> points to Render, the Pages workflow loses access to repo secrets and
> the deploy can fail. If you disable the Pages workflow before DNS
> points to Render, acschennai.com freezes. Each step depends on the
> previous one being observably live.

---

## 1. Add the custom domain in Render

In the Render dashboard:

1. Open the static site **`acs-portal-spa`**
   (service id `srv-dad741lg1s2s73fatpf0`).
2. Go to **Settings → Custom Domains**.
3. Click **Add Custom Domain**.
4. Add **two** entries:
   - `acschennai.com` (apex / root domain)
   - `www.acschennai.com` (www subdomain)
5. Render will, at this point, display the exact DNS records it expects
   you to create. **Copy those records verbatim** before proceeding.
   They will look something like:

   | Host                  | Type    | Value (example, not real)            |
   |-----------------------|---------|--------------------------------------|
   | `acschennai.com`      | `ALIAS` | `acs-portal-spa.onrender.com`        |
   | `acschennai.com`      | `A`     | `<Render apex IP 1>`                 |
   | `acschennai.com`      | `A`     | `<Render apex IP 2>`                 |
   | `www.acschennai.com`  | `CNAME` | `acs-portal-spa.onrender.com.`       |

   > **Do not invent IP addresses here.** Render assigns the IPs; copy
   > what the dashboard shows. If the dashboard only shows an `ALIAS`
   > record (some DNS providers like Cloudflare support `ALIAS`/`ANAME`),
   > use that and skip the `A` records.

> **Note on `render.yaml`:** the Blueprint does NOT declare the custom
> domain. Render Blueprints can declare `domains:` on a service but it
> is brittle (Render requires the apex to be already on their
> infrastructure before apply), and many teams prefer to attach domains
> through the dashboard. If you want it in IaC instead, add a
> `domains:` array on the static site entry in `render.yaml` with
> `name: acschennai.com` and `name: www.acschennai.com`. The runbook
> below assumes dashboard-driven attachment.

---

## 2. Change DNS records

Wherever `acschennai.com`'s DNS is hosted (Cloudflare, Route53, the
registrar, etc.) — replace the existing GitHub Pages records with the
Render records from step 1.

### Current (Pages) — record what you remove so rollback is one paste

| Host                 | Type    | Value                                          |
|----------------------|---------|------------------------------------------------|
| `acschennai.com`     | `A`     | `185.199.108.153`                              |
| `acschennai.com`     | `A`     | `185.199.109.153`                              |
| `acschennai.com`     | `A`     | `185.199.110.153`                              |
| `acschennai.com`     | `A`     | `185.199.111.153`                              |
| `www.acschennai.com` | `CNAME` | `adithya300800.github.io.` (or equivalent)     |

### Target (Render) — paste from what you copied in step 1

Replace each Pages record with its Render counterpart. Apex usually
becomes an `ALIAS`/`ANAME` to `acs-portal-spa.onrender.com` OR an `A`
record set to Render-published IPs. The www record becomes a `CNAME` to
`acs-portal-spa.onrender.com.`

> **TTL heads-up.** If the existing records have a low TTL (≤ 300 s)
> you're fine. If they have a long TTL (≥ 3600 s), lower the TTL at
> least 24 hours before this step so the cutover propagates fast.

> **DNSSEC note.** If the zone is DNSSEC-signed, do NOT disable DNSSEC
> as part of this change; only re-sign if you actually swap the DS
> record. Render is fine with DNSSEC.

---

## 3. Wait for DNS propagation and TLS issuance

1. From any external host, poll:
   ```bash
   dig +short acschennai.com A
   dig +short www.acschennai.com CNAME
   ```
   When the answers match the Render records (not the Pages IPs),
   propagation has reached you. Expect 5 min – 48 h depending on TTL.
2. Render provisions a Let's Encrypt cert automatically when the DNS
   resolves correctly to Render. In the dashboard, the custom domain
   row should flip from `pending` / `unverified` to `verified` /
   `active`. Wait for that — **do not proceed** until both apex and
   www show healthy.
3. If either domain stays unverified after 30 minutes, re-check the
   exact records you pasted (trailing dot on CNAMEs, ALIAS vs A,
   proxy-disabled on Cloudflare). Render's status panel will tell you
   what it's seeing.

---

## 4. Verify the cutover end-to-end — **before** disabling Pages

Run all four checks. They must ALL pass before you touch step 5.

```bash
# 4a. apex serves the React bundle from Render
curl -sI https://acschennai.com/ | head -1
#   expect: HTTP/2 200
#   expect: server header mentions render (or no GitHub-Pages marker)

# 4b. deep link works through the rewrite (this is what proves
#     the SPA fallback is active — Pages returns 404 for /portal/login)
curl -sI https://acschennai.com/portal/login | head -1
#   expect: HTTP/2 200  (NOT 404)

# 4c. www redirect or mirror works
curl -sI https://www.acschennai.com/ | head -1
#   expect: HTTP/2 200  (Render serves www directly via the CNAME)

# 4d. the bundle is actually talking to the Render backend, not Pages
curl -s https://acschennai.com/ | grep -oE 'https://acs-chennai\.onrender\.com[^"]*' | head -1
#   expect: https://acs-chennai.onrender.com  (NOT Pages, NOT localhost)
```

Also do a browser check:

- Open https://acschennai.com/portal/login in a hard-refreshed
  incognito window. Confirm the bundle loads, you can sign in, and
  network traffic in DevTools shows requests going to
  `acs-chennai.onrender.com` (not Pages).
- Open https://acs-portal-spa.onrender.com/portal/login in a separate
  window — it should be byte-identical (same bundle, same backend).

If any of 4a–4d fail, **do not proceed to step 5.** Roll back per
step 8, debug, then re-run from step 1.

---

## 5. Disable the GitHub Pages workflow

Only after step 4 is fully green:

1. Open `.github/workflows/deploy.yml`. Comment-out or `on:`-gate the
   triggers so it never runs again:
   ```yaml
   on:
     # push:
     #   branches: [ add-react-website ]
     #   paths-ignore:
     #     - 'backend/**'
     workflow_dispatch:
   ```
   Keeping `workflow_dispatch` lets you re-run it manually for one
   final emergency rollback if needed (see step 8). You can also
   delete the workflow file entirely once the repo is private and
   you've validated Render for a full release cycle — but DO NOT
   delete it before step 7.
2. Commit and push that change to `add-react-website`. The Pages
   deploy will run one more time on this push; that is fine and
   expected — it keeps the Pages artifact warm in case of rollback.
3. Sanity-check: `https://acschennai.com` is still being served by
   Render (Render is unaffected by GitHub workflow state).

> **Why not delete the workflow file outright?** Because if you later
> need to roll back DNS to Pages (step 8), the Pages deploy won't
> happen unless the workflow is still runnable. Disabling the
> triggers while leaving the file in tree gives you a one-click
> rollback path. Delete only once you've been on Render for at least
> one full release cycle without incident.

---

## 6. Stop publishing to GitHub Pages (optional cleanup)

If you also want to remove the Pages site entirely:

1. Repo **Settings → Pages** → set source to **None**.
2. This stops the GitHub Pages artifact from being served at all.
3. (Optional) Repo **Settings → Pages** → uncheck "Enforce HTTPS" if
   it's still showing, and remove the custom domain field from the
   Pages settings page (it currently says `acschennai.com`).

You can keep doing this even with the repo public; doing it before
making the repo private just keeps the public surface smaller.

---

## 7. Flip the repository to private

1. Repo **Settings → General → Danger Zone → Change repository
   visibility → Make private**.
2. Confirm.
3. Watch the next Render auto-deploy: Render pulls from GitHub via a
   deploy hook tied to the public repo URL. After visibility flips
   to private, Render's existing connection may break on the next
   deploy unless Render is installed as a GitHub App with private
   repo access (check Settings → GitHub App on Render).
4. Verify by pushing a small change to `add-react-website` and
   confirming a new Render deploy fires (or manually trigger a
   deploy from the Render dashboard). If Render can't see the repo
   any more, the dashboard will tell you; install the Render GitHub
   App on the org with access to this repo and re-link the service.

> **Do this LAST.** If you make the repo private before step 5/6,
> Render may lose access on its next deploy *and* Pages deploys
> will silently break. Order matters: DNS → verify → disable Pages
> → then private.

---

## 8. Rollback (if anything goes wrong)

If at any point after step 2 the site is broken, you can revert in
under a TTL:

1. **DNS rollback** — restore the four Pages A records for
   `acschennai.com` and the Pages CNAME for `www.acschennai.com`
   (you recorded these in step 2):
   ```
   acschennai.com     A     185.199.108.153
   acschennai.com     A     185.199.109.153
   acschennai.com     A     185.199.110.153
   acschennai.com     A     185.199.111.153
   www.acschennai.com CNAME adithya300800.github.io.
   ```
2. Wait for the old TTL to elapse.
3. Re-enable the Pages workflow (revert the step 5 commit) so any
   subsequent frontend push ships to Pages.
4. `curl -sI https://acschennai.com/portal/login` should now return
   `HTTP/2 404` again — that confirms you're back on Pages (Pages
   doesn't have the `_redirects`-equivalent rewrite unless you've
   shipped it there too, which we deliberately did not).
   > If 404 is unacceptable during rollback, temporarily also revert
   > the public/_redirects-friendly flow by pushing a `404.html`
   > that does the same rewrite. Or accept the 404 on deep links
   > for the rollback window — it's only as long as the DNS TTL.

DNS rollback is the safe path; Render can stay configured with
`acschennai.com` attached but the apex will simply not resolve to it
once the A records point back at Pages.

---

## 9. `render.yaml` caveats

- The Blueprint declares the **two services** and their build/start
  commands, regions, plans, and build-time env vars.
- It does NOT declare the custom domain (apex + www). Render
  Blueprint supports a `domains:` field on static sites, but
  applying it before the apex is on Render's infrastructure can
  fail. Attach the domain through the dashboard (step 1) instead.
  Once the apex is live on Render, you can re-add `domains:` to
  `render.yaml` for a fully-IaC version.
- All real secrets are marked `sync: false`. They live in the
  Render dashboard and are preserved across Blueprint applies. Do
  not add real secret values to this file.
- The Blueprint assumes the static site's `staticPublishPath` is
  `./dist` and that `npm run build` produces that directory at the
  repo root. If either changes, update this file.
- Schema note: per <https://render.com/docs/blueprint-spec>, a static
  site is `type: web` + `runtime: static` (there is no `static_site`
  type), the publish key is `staticPublishPath` (not `publishPath`),
  and `runtime:` replaces the deprecated `env:`. The Blueprint was
  corrected to match; parse-checked with `js-yaml`.
- The backend's CORS allow-list is the `ALLOWED_ORIGINS` env var read
  at `backend/src/index.js:86` — it is **not** hard-coded in source,
  and `index.js:91` throws at boot in production if it and
  `FRONTEND_URL` are both empty. Keep `https://acschennai.com` in the
  list after cutover: the apex is still the browser origin, it is
  just served by Render instead of Pages.
- The static-site `routes` block (`/*` → `/index.html`) is the IaC
  equivalent of `public/_redirects`. The latter is kept for tooling
  that reads Netlify-style redirect files; both should agree.

---

## 10. Open follow-ups after cutover

- [ ] Decide whether to delete `public/_redirects` once nothing
      reads it any more (Render's `routes` block supersedes it).
- [ ] Delete `.github/workflows/deploy.yml` after at least one
      successful full release cycle on Render with no incidents.
- [ ] Add a Render status check / uptime probe for
      `https://acschennai.com` so a future regression doesn't go
      unnoticed.
- [ ] Audit the live Render env vars once more after the repo goes
      private, in case any leaked during the public-repo window
      (see `post-deploy-secret-rotation.md` in repo memory for the
      rotation playbook used in round 25).

---

**Status:** Awaiting human review; requires manual Render dashboard + DNS steps.
**Status:** Awaiting human review of `render.yaml` and this runbook.
**First action required:** human — open Render dashboard and start
step 1.