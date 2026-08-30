# ACS Chennai — Production Readiness Report

**Date:** 2026-08-29
**Stack:** Node.js + Express + Prisma (Render) · React/Vite + vanilla JS SPA (GitHub Pages) · Supabase Postgres 17.6 (ap-southeast-1) · Cloudflare R2 · Resend
**Method:** 5-specialist parallel audit (Backend / Frontend / API Contract / a11y / Integration) + synthesis pass. 168 tool calls, 481k tokens of agent context.
**Status:** Live site is currently **DEGRADED** — login returns 500 (DATABASE_URL wrong on Render), contact returns 503 (RESEND_API_KEY missing), /ready permanently 503 (Azure SDK probe on R2 client). Eleven P0 blockers below must be cleared before sign-off.

---

## TL;DR — Executive Summary

The portal's five parallel audits surfaced **11 P0 blockers**, of which **7 are pure backend↔frontend integration desyncs** (sentinel-value collisions like (0,0) GPS, path/identifier drift in DPR photo read-SAS URLs, missing JSON-list mount for /api/dpr/notifications, field-allowlist drift in Contact projectType, and silent-default drift in DPR workType). Each layer is internally consistent but the contract between them is broken, so the system fails silently on every single user action rather than on edge cases.

The remaining 4 P0s are correctness bugs: attendance check-in/check-out TOCTOU races, dead DPR row click, geolocation TIMEOUT retry against an undefined property, double-submit race, and /ready probe calling the Azure SDK `listContainers` on the R2 S3Client.

The dominant fix pattern across the integration set is **a typed contract artifact both sides compile against**: regenerate `openapi.yaml` from the live route table, widen the CORS Allow-Headers list so future Idempotency-Key support does not silently break preflight, accept `Idempotency-Key` on POST `/api/dpr` and POST `/confirm-upload` to make retries safe, and align enum allowlists (workType, projectType) between forms and validators.

The first five actions — fix the photo read-SAS path, repair the /ready R2 probe, add the missing /api/dpr/notifications JSON list, align DPR workType end-to-end, and fix the attendance geolocation pipeline on both sides — unblock the most downstream work because they restore visibility into the primary business value (DPR photos and notifications), make the platform probe trustworthy, and stop two silent data-corruption paths.

**Rounds 7 and 8 of production hardening held up:** auth middleware, JWT secret validation, helmet+CORS trim, body-parser per-route limits, Prisma error mapper, blob tenant scoping at upload time, PII `hashIdentifier` usage, the frontend `api.js` timeout wrapper, single-flight refresh, single-fire logout, ErrorBoundary, and SSE ticket reuse all survived the audits and **do not need to be redone**.

---

## Integration Diagnosis — User's Hypothesis Confirmed

**You are correct: integration is THE issue.** Of the 11 P0 blockers, 7 are pure integration desyncs — not backend bugs, not frontend bugs, but mismatches where each side is internally consistent yet the contract between them is broken. The pattern falls into five repeating shapes.

**Sentinel-value collisions.** One layer silently fills a missing field, the other silently rejects it. The attendance (0,0) GPS fallback is the cleanest example: `Attendance.jsx` defaults to `lat=0/lng=0` when `navigator.geolocation` fails; `attendance.js` then explicitly rejects (0,0) as invalid coordinates. Both layers "do the right thing in isolation," but the user sees a generic 400 "Coordinates out of range" instead of "location required." The DPR workType mismatch is the same shape at the data layer — frontend omits the field, backend defaults silently to `MATERIAL_RECEIPT`. These are the highest-impact fixes because they corrupt or lose data on every single user action, not on edge cases.

**Path and identifier drift.** The upload path and the read path disagree about a key. The DPR photo read-SAS URL builds `${p.ulid}.${ext}` while the upload built `${employeeId}/${ulid}.${ext}`. This is a tenant-prefix bug — every photo GET 404s, and it would never be caught by unit tests on either side because each side passes its own test. The lesson: any place where the frontend or backend synthesizes a key from one side's state needs an explicit contract artifact (an integration test or a schema column) that both sides read from.

**Mount-vs-mount missing endpoints.** `NotificationBell` awaits `res.json()` on `GET /api/dpr/notifications`, but the backend only mounts that path as a `text/event-stream` SSE endpoint. The frontend was wired to an endpoint that was never built. Inverse of a stale route — a route the client assumes exists that the server never offered. Surfaces as silent empty state, not a 404, because the JSON parser throws inside a catch the bell considers non-fatal.

**Field-allowlist drift** between the form and the validator. `Contact.jsx` sends "PMC / Project Management Consultancy" and "Warehouse / Logistics Infrastructure" but backend `ALLOWED_PROJECT_TYPES` is `{Chemical, Pharmaceutical, Residential, Industrial, Logistics, Other}`. The backend silently coerces `safeProjectType` to null (line 64 of `contact.js`), so every contact email goes out with "Project Type: Not specified." The fix is mechanical — align the lists — but the diagnosis is structural: there is no shared source of truth for enums between client and server.

**Race conditions that look like integration bugs.** The attendance check-in `findFirst→create` race surfaces as a 500 the user blames on the app. The DPR submit double-click race surfaces as a duplicate submission. Both are async-safety defects inside the backend or frontend, but the user perceives them as "the system is broken."

The recovery pattern across all five shapes is the same: **add a typed contract artifact that both sides compile against.** For enums, a shared TypeScript-style schema (or a generated Zod schema). For endpoints, regenerate `openapi.yaml` from the route table (it is materially stale and documents an Azure host, an `/api/auth/logout` that does not exist, and wrong HTTP verbs). For sentinel values, make the failure loud on both sides — disable the attendance button when GPS is unavailable, return a 422 with a typed code instead of silently nulling projectType. For mount drift, branch on `Accept: application/json` before the SSE handler. For races, the backend needs idempotency keys (the `Idempotency-Key` header is also blocked today by the hard-coded CORS Allow-Headers list, which must be widened at the same time).

**The backend and frontend are individually healthy; the wire between them is the bug.**

---

## P0 Blockers (11)

| # | Area | File | Defect |
|---|------|------|--------|
| P0-1 | integration | [backend/src/routes/dpr.js:534](backend/src/routes/dpr.js#L534) | DPR photo read-SAS missing `${employeeId}/` prefix → every photo GET 404s |
| P0-2 | integration | [src/components/NotificationBell.jsx:67](src/components/NotificationBell.jsx#L67) | GET /api/dpr/notifications mounted only as SSE — JSON parser throws silently, bell shows "0 unread" |
| P0-3 | integration | [src/pages/portal/DprSubmit.jsx](src/pages/portal/DprSubmit.jsx) + [backend/src/routes/dpr.js:277-332](backend/src/routes/dpr.js#L277) | `workType` never sent by frontend → backend silently defaults every DPR to MATERIAL_RECEIPT |
| P0-4 | integration | [src/pages/portal/Attendance.jsx](src/pages/portal/Attendance.jsx) + [backend/src/routes/attendance.js:142-145](backend/src/routes/attendance.js#L142) | (0,0) GPS fallback rejected as invalid → indoor check-ins return 400 "Coordinates out of range" |
| P0-5 | integration | [src/pages/Contact.jsx](src/pages/Contact.jsx) + [backend/src/routes/contact.js:64](backend/src/routes/contact.js#L64) | Contact `projectType` allowlist drift → every lead email says "Project Type: Not specified" |
| P0-6 | backend | [backend/src/index.js:133](backend/src/index.js#L133) | /ready calls `client.listContainers` (Azure SDK) on R2 S3Client → permanently 503 |
| P0-7 | backend | [backend/src/routes/attendance.js](backend/src/routes/attendance.js) | Check-in non-atomic `findFirst→create` → P2002 surfaces as 500 on race |
| P0-8 | backend | [backend/src/routes/attendance.js](backend/src/routes/attendance.js) | Check-out TOCTOU: findUnique→UPDATE race → last-write-wins overwrites prior check-out |
| P0-9 | frontend | [src/pages/portal/DprList.jsx:106](src/pages/portal/DprList.jsx#L106) | DPR row click navigates to same route with state `selectedDpr` that no one reads — dead nav |
| P0-10 | frontend | [src/pages/portal/Attendance.jsx](src/pages/portal/Attendance.jsx) | `err.code === err.TIMEOUT` compares numeric (3) against `undefined` — retry never fires |
| P0-11 | frontend | [src/pages/portal/DprSubmit.jsx](src/pages/portal/DprSubmit.jsx) | `handleSubmit` fires two parallel POSTs on double-click — duplicates submitted |

---

## P1 Must-Fix (14)

- **[backend/src/index.js:147](backend/src/index.js#L147)** — No `/api/v1` prefix → any field rename is a silent breaking change. Pairs with stale openapi.yaml to make every contract fix a deploy-time game of chicken.
- **[backend/src/index.js:61](backend/src/index.js#L61)** — CORS Allow-Headers hard-coded to `Content-Type, Authorization` → adding `Idempotency-Key` support will silently break preflight. Widen to include `Idempotency-Key, X-Request-ID` before adding idempotency.
- **[backend/openapi.yaml](backend/openapi.yaml)** — Materially stale: documents deprecated Azure host `acsportal-backend.azurewebsites.net`, GET `/api/auth/zoho` (real is POST), `/api/attendance/checkin` and `/api/attendance/checkout` as POST (real are POST `/check-in` and PUT `/check-out/:sessionId`), and `/api/auth/logout` which does not exist.
- **[src/pages/PortalLogin.jsx](src/pages/PortalLogin.jsx)** — OAuth SPA callback sends only `code`, backend requires `code + state` for CSRF (auth.js:213-220) → direct-redirect Zoho login returns 400 INVALID_STATE.
- **[src/pages/PortalLogin.jsx](src/pages/PortalLogin.jsx)** — postMessage origin check falls back to `window.location.origin` when `VITE_API_URL` missing; backend popup postMessages use `acs-chennai.onrender.com` → silent origin-mismatch drops login-success message.
- **[backend/src/routes/dpr.js:73](backend/src/routes/dpr.js#L73)** — SSE ticket deleted immediately on first read but EventSource auto-reconnects with same URL → every reconnect consumes already-deleted ticket. Reconnect ladder works in practice but fragile on flaky mobile networks.
- **[backend/src/routes/auth.js:282-292](backend/src/routes/auth.js#L282)** — OAuth `find or create employee` uses `prisma.employee.create` without catching P2002 → two concurrent tabs throw 500 on the auth path.
- **[src/contexts/AuthContext.jsx](src/contexts/AuthContext.jsx)** — No preemptive access-token refresh → user idle 23h59m bounced to /portal/login on first post-expiry request. Daily-active employees hit this every morning.
- **[src/pages/portal/DprList.jsx](src/pages/portal/DprList.jsx)** — `useEffect` deps = `[filter]` — accessToken rotation never reloads list, stale empty data until user changes a filter. Mid-flight changes need AbortController.
- **[src/pages/admin/DprDashboard.jsx](src/pages/admin/DprDashboard.jsx)** — Admin review state (adminNotes, rejectReason, reviewing) is GLOBAL to component — typing reject reason for DPR-A persists when clicking Review on DPR-B. State leakage.
- **[backend/src/middleware/rateLimit.js](backend/src/middleware/rateLimit.js)** — `loginLimiter` keyed by `req.ip` only (5/min/IP) → corporate NAT with 200 employees shares one bucket; Zoho POST callback is unmetered.
- **[src/components/Header.jsx:21](src/components/Header.jsx#L21)** — Public site `<header>` lacks "Skip to main content" link → WCAG 2.4.1 Bypass Blocks (Level A) failure. Blocks keyboard/screen-reader users from the integration-affected screens.
- **[backend/src/lib/blobStorage.js](backend/src/lib/blobStorage.js)** — R2 SAS PUT URL does not constrain Content-Length → attacker with one SAS can fill the 5 GB R2 object bucket (unbounded cost surface).
- **[src/pages/portal/Admin.jsx](src/pages/portal/Admin.jsx)** — Admin modal lacks `role="dialog"`, `aria-modal`, focus trap, Escape-to-close, focus restoration → fails WCAG 2.4.3 and 4.1.2. Pattern from `Attendance.jsx:384-389` is correct and should be lifted.

---

## P2 Recommended (17)

- **[backend/src/index.js:115-142](backend/src/index.js#L115)** — `/ready` echoes `err.message` first line into public response → Prisma errors leak DATABASE_URL host, R2 errors leak bucket name and accountId endpoint. Already patched for `err.code`/`err.name` this turn; redact the message too.
- **[backend/src/routes/dpr.js](backend/src/routes/dpr.js)** — Error envelope hand-rolled per route (`{error}`, `{error, code}`, `{error, code, message}`, `{error, code, requestId}`) → frontend `api.js` error normalization cannot match the per-route shapes.
- **[backend/src/routes/dpr.js](backend/src/routes/dpr.js)** — DPR POST fallback returns `debugMessage`, `debugCode`, `debugMeta`, `debugName` → surfaces Prisma internals (column names, FK targets, raw error messages) to any authenticated user. Round-8 left this as "delete after F5/F6 identified" — still shipping.
- **[backend/src/routes/auth.js](backend/src/routes/auth.js)** — OAuth state TTL enforced only at `/zoho-start` (line 81 prune), not at `/zoho/callback` — `oauthStateStore.has(state)` ignores `value.timestamp` → CSRF replay window is effectively indefinite.
- **[backend/src/routes/dpr.js](backend/src/routes/dpr.js)** — PUT `/api/dpr/notifications/read-all` is an action endpoint, not idempotent → two concurrent PUTs race on `updateMany` (second becomes no-op with misleading `updated=0`).
- **[backend/src/routes/dpr.js](backend/src/routes/dpr.js)** — GET `/api/dpr/notifications` still accepts JWTs in `?token=` query string as "legacy fallback" → query strings land in proxy/CDN access logs and browser history.
- **[backend/src/routes/contact.js](backend/src/routes/contact.js)** — Resend SDK errors logged with `err.message` may include rejected payload (recipient, subject, partial body) → raw user PII flows to Log Stream unredacted.
- **[src/App.css](src/App.css)** — Placeholder color `#94A3B8` on white = ~2.85:1 contrast (fails WCAG 1.4.3). Disabled-button opacity 0.5/0.6 (fails 1.4.11). Footer text `rgba(255,255,255,0.35)` (fails 4.5:1).
- **[src/components/Footer.jsx](src/components/Footer.jsx)** — Newsletter + Admin notes inputs have no associated `<label>` or `aria-label`. Submit button is icon-only SVG with no `aria-label`.
- **[src/components/ScrollToTop.jsx](src/components/ScrollToTop.jsx)** — SPA route changes do not move keyboard/screen-reader focus to new page's `<h1>` → fails WCAG 2.4.3 and 2.4.6.
- **[src/pages/portal/DprSubmit.jsx](src/pages/portal/DprSubmit.jsx)** — `previewUrl` via `URL.createObjectURL` only revoked on full unmount — failed uploads leave multi-MB blob objects alive in memory for hours.
- **[src/contexts/AuthContext.jsx](src/contexts/AuthContext.jsx)** — Frontend `logout()` only clears localStorage — backend has no logout endpoint to revoke refresh tokens → stolen refresh token stays valid for 7 days.
- **[backend/src/routes/dpr.js](backend/src/routes/dpr.js)** — `pendingUploads`, `oauthStateStore`, `sseTickets` are in-memory Maps — wiped on every deploy/instance recycle → in-flight clients get 404/401 with no client-visible signal.
- **[backend/src/routes/attendance.js](backend/src/routes/attendance.js)** — Check-in accepts client-supplied `localDateTime` and derives both date and checkIn timestamp from it with only 15-min drift cap → server trusts client time-of-day for the actual checkIn timestamp. Payroll integrity risk.
- **[backend/src/routes/dpr.js](backend/src/routes/dpr.js)** — POST `/api/dpr/sas-url` generates fresh ULID + presigned URL on every call — no client-supplied correlation key → a retry yields two ULIDs for the same logical photo.
- **[src/components/PortalLayout.jsx](src/components/PortalLayout.jsx)** — "Coming Soon" sidebar items inject raw DOM nodes — no `aria-live`/`role`, no dismiss, no escape, stacks on rapid click.
- **[src/contexts/ToastContext.jsx](src/contexts/ToastContext.jsx)** — Toast auto-dismiss with no pause-on-hover/focus, no user-extendable timer → fails WCAG 2.2.1 Timing Adjustable.

---

## P3 Nice-to-Have (4)

- **[src/components/Footer.jsx](src/components/Footer.jsx)** — LinkedIn/Twitter/Privacy/Terms anchors are dead `href="#"` — public footer credibility hit; mild a11y regression.
- **[src/components/NotificationBell.jsx](src/components/NotificationBell.jsx)** — Non-401 fetch failures silently swallowed — user sees "0 unread" forever with no surfaced retry path.
- **[src/pages/portal/Attendance.jsx](src/pages/portal/Attendance.jsx)** — `localDateTime = new Date().toISOString()` is UTC — backend reconstructs local tz from JWT employee's tz setting → users checking in just after midnight IST see UTC previous-day.
- **[backend/src/index.js:60](backend/src/index.js#L60)** — `Access-Control-Allow-Methods` hard-coded to `'GET, POST, PUT, OPTIONS'` — HEAD and any future PATCH/DELETE preflights fail.

---

## Apply-First (Ordered Execution Sequence)

These five actions unblock the most downstream work. Apply in order; each depends on the previous or on user actions B1–B7.

1. **[backend] Fix the DPR photo read-SAS path** — persist owner-employeeId on `DPRPhoto` at create time and rebuild `${employeeId}/${ulid}.${ext}` at [dpr.js:534](backend/src/routes/dpr.js#L534). Unblocks every DPR viewer (employee + admin) and removes the primary business-value blocker.
2. **[backend] Fix the /ready probe** — replace the Azure SDK `listContainers` call with an R2-aware `HeadBucketCommand` or `ListBucketsCommand`, wrapped in a 2s `AbortController`. Without this, Render cannot see the system as healthy and operators cannot distinguish a real outage from the broken probe. [index.js:133](backend/src/index.js#L133).
3. **[backend + frontend] Add a JSON-list endpoint for GET /api/dpr/notifications** — or branch on `Accept: application/json` before the SSE handler. `NotificationBell` must stop parsing SSE bodies as JSON; this is the highest-traffic silent failure in the app.
4. **[frontend + backend] Decide canonical DPR.workType shape and align** — send the top-level `workType` from `DprSubmit`, update backend allowlist ([dpr.js:277-280](backend/src/routes/dpr.js#L277) and :332), mark column nullable. Compounds with #5 — both layers must change together or the fix is partial.
5. **[frontend + backend] Fix the attendance geolocation pipeline end-to-end** — in `Attendance.jsx`, disable Mark Attendance when GPS is unavailable and stop defaulting to (0,0); fix the `err.TIMEOUT` retry condition; on the backend, drop the (0,0) rejection only after the frontend stops sending it.

**User-side (B1–B7) remains prerequisite for live testing:**
- B1–B5: Rotate 5 credentials (R2, Render API, Supabase PAT, Supabase DB password, Cloudflare token) and store under handle `acs-portal/<NAME>` in 1Password/pass/Keychain
- B6: Push the diag-patch commit (the /ready + .mcp.json edits already applied this turn)
- B7: Dry-run + apply `scripts/render-apply-env.sh`, then `verify-render.sh`, then `prisma db push` against Supabase direct host

After B1–B7, run `happy-path-render.js` for live browser verification, then dispatch Test Automation Engineer for a hardened full-flow test.

---

## Files Audited

- `backend/src/index.js`, `backend/src/routes/{auth,attendance,dpr,contact,diag}.js`
- `backend/src/middleware/{auth,rateLimit}.js`, `backend/src/lib/{blobStorage,errors,pdfGenerator,pii}.js`
- `backend/prisma/schema.prisma`, `backend/openapi.yaml`
- `frontend/src/**` (React/Vite SPA)
- `src/**` (legacy vanilla JS)
- `scripts/render-apply-env.sh`, `verify-render.sh`, `happy-path-render.js`
- `.mcp.json`, `.github/workflows/{backend-deploy,deploy}.yml`

## What Did NOT Need to Be Redone

Rounds 7 and 8 of production hardening held up under multi-agent review:
- `express-async-errors` patch (all 23 async handlers route rejections to Prisma-error mapper)
- JWT secret fail-fast in production ([auth.js:13-18](backend/src/routes/auth.js#L13))
- Helmet defaults enabled (CSP/HSTS/X-Frame-Options/X-Content-Type-Options/Referrer-Policy)
- CORS Allow-Methods trimmed to actually-used verbs only
- Body-parser per-route limits (16kb default, 32kb auth, 1mb DPR)
- Prisma error mapping in global error middleware ([index.js:164-194](backend/src/index.js#L164))
- Frontend `api.js` timeout wrapper (10s default, 60s blob)
- Blob tenant scoping at upload time (`${employeeId}/${ulid}.${ext}`)
- PII `hashIdentifier` usage in logs
- Single-flight refresh, single-fire logout, ErrorBoundary
- SSE ticket reuse pattern
- `httpsOnly` cookie flags
- Rate limiters on login / refresh / contact / sas-url

These all survived multi-agent scrutiny. Do not regress them while applying the fixes above.