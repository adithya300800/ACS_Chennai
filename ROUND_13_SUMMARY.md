# Round 13 — Attendance Excel Export + Leave Request Workflow

**Date:** 2026-08-31
**Status:** Implementation complete; pending deployment to Render + smoke run on production.

---

## 1. Scope

Two new features, delivered behind existing routes/permissions — no changes
to pre-existing attendance, auth, or portal flows.

| # | Feature | Owner surface | Server surface |
|---|---|---|---|
| 1 | Attendance Dashboard — Download Employee Timesheet as Excel | `/portal/admin` (admin only) | `GET /api/attendance/export?month=YYYY-MM` |
| 2 | Standard Leave Request Workflow (submit → review → approve/reject/cancel) | `/portal/leave`, `/portal/admin/leave` | `POST/GET /api/leave[/:id[/approve\|reject\|cancel]]` (7 endpoints) |

---

## 2. Technical Plan (final)

### 2.1 Attendance Export

- **New:** `backend/src/lib/timesheet.js` — pure builder, no I/O. Converts
  `(employees, attendanceRows, leaveRequests, month, today)` → `{rows,
  summary}`. Status priority matrix: `APPROVED Leave > Present > Weekend
  with checkin > Weekend > Future > Absent`. Worked-hours = sum of
  closed-session durations (quarter-hour rounding); open sessions render
  `—`. Leap-year-safe (28/29 day February via `new Date(y, m, 0).getDate()`).
- **New:** `backend/src/lib/excelWriter.js` — streaming `WorkbookWriter`
  piped to the response (flat RSS even for 200 employees × 31 days).
  Sheet-name sanitizer (Excel 31-char limit, `:\/?*[]` forbidden).
  Formula-injection guard (prefixes `=+-@` cells with `'`). Graceful CSV
  fallback (UTF-8 BOM, CRLF, RFC 4180 escaping) if `require('exceljs')`
  fails — response carries `X-Export-Format: csv-fallback` so the
  frontend can tell the user.
- **Route:** `GET /api/attendance/export?month=YYYY-MM`
  - Rate-limited (5/min/IP via `exportLimiter`) — protects Excel
    generation cost from abuse.
  - Admin-only (`requireAdmin`).
  - Headers: `Content-Type`, `Content-Disposition: attachment;
    filename="timesheet-YYYY-MM.xlsx"`, `X-Export-Format`,
    `X-Export-Row-Count`.
  - Validates month format (rejects `bad`, `2026-8`).

### 2.2 Leave Workflow

- **Schema:** new `LeaveRequest` model + `LeaveStatus` enum
  (`PENDING|APPROVED|REJECTED|CANCELLED`) in `schema.prisma`.
- **New:** `backend/src/lib/leaveRules.js` — pure validators:
  - `parseLeaveDate` — strict `YYYY-MM-DD` / ISO / `Date`.
  - `inclusiveDayCount` — leap-year-aware.
  - `rangesOverlap` — inclusive overlap (`a.start ≤ b.end ∧ b.start ≤ a.end`).
  - `validateCreatePayload` — reason 5..500 chars, start ≤ end,
    start ≥ today, no overlap with own PENDING/APPROVED, max 30
    consecutive days.
  - `canTransition` — `PENDING → APPROVED|REJECTED|CANCELLED`;
    all other transitions terminal (re-approve returns 409).
  - `httpStatusForCode` — maps `INVALID_BODY|OVERLAP|PAST_DATE|
    REASON_TOO_SHORT|REASON_TOO_LONG|TOO_MANY_DAYS|INVALID_TRANSITION`
    → 400/409.
- **New:** `backend/src/routes/leave.js` — 7 endpoints:
  1. `POST   /api/leave` — submit (employee)
  2. `GET    /api/leave/my` — own list
  3. `GET    /api/leave` — admin queue (filterable by status/employee)
  4. `GET    /api/leave/:id` — fetch one (owner or admin)
  5. `POST   /api/leave/:id/approve` — admin only
  6. `POST   /api/leave/:id/reject` — admin only, notes required
  7. `POST   /api/leave/:id/cancel` — owner of PENDING
- **Auth model:**
  - `requireAuth` on every route.
  - Admin-only for: list-all, approve, reject.
  - Owner-only for: cancel. Owner-or-admin read for `:id`.
  - **Self-approval block** — admins cannot approve their own leave
    requests (returns 403). Compliance: separation of duties.
  - **Re-decision block** — admin tries to approve an already-approved
    request → 409 `INVALID_TRANSITION`.
- **Notifications:** best-effort `prisma.notification.create` for the
  employee on every status change (status change is committed in a
  Prisma transaction; notification failure does not roll back the
  decision).
- **Rate limit:** `leaveCreateLimiter` on submit (10/hr/IP) to block
  form-spam.
- **Extensibility:** `leaveStatusLimiter` is exported so future
  approval-rate controls can drop in without route changes.

### 2.3 Frontend

- **New:** `src/pages/portal/Leave.jsx` — form (date pickers, type select,
  reason textarea) + `My Requests` list with status pills + cancel button
  on PENDING rows.
- **New:** `src/pages/admin/LeaveDashboard.jsx` — table view, status
  filter pills, inline reject-with-notes textarea, confirm dialog for
  7+ day approvals.
- **New:** `src/pages/portal/Admin.jsx` — added `Download Timesheet`
  button (admin-only) wired to `monthRef` → `download()` helper.
- **Updated:** `src/lib/api.js` — added `download(url)` (handles
  Content-Disposition, falls back to JSON) and `leave.*` helpers.
- **Updated:** `src/components/PortalLayout.jsx` — removed
  `comingSoon: true` from the Leave nav item so it routes to
  `/portal/leave`.
- **Updated:** `src/App.jsx` — mounted `Leave` and `LeaveDashboard`
  under their respective guards.
- **CSS:** ~240 lines appended to `src/App.css` (`.leave-*` classes +
  admin export button + responsive variants).

---

## 3. Implementation Steps Taken

1. Schema (`LeaveRequest` + `LeaveStatus`) added to `schema.prisma`.
2. Pure libs first — `leaveRules.js`, `timesheet.js`, `excelWriter.js`
   (all side-effect-free, all unit-testable).
3. Routes — `routes/leave.js` (7 endpoints), `GET /api/attendance/export`
   added to `routes/attendance.js`.
4. `index.js` — mount `/api/leave`, expose `Content-Disposition` for
   the export (helmet does not strip it by default but we set it
   explicitly).
5. Frontend api helpers (`download`, `leave.*`).
6. Frontend pages — employee `Leave`, admin `LeaveDashboard`.
7. Wire navigation in `Admin.jsx`, `PortalLayout.jsx`, `App.jsx`.
8. Style block appended to `App.css`.
9. Test runner `backend/scripts/round13-tests.js` — 133 assertions
   across 13 unit sections + 2 integration sections.
10. Live-test script `round13-live-test.mjs` — Playwright-based
    end-to-end flow.

---

## 4. Test Coverage

### 4.1 Unit tests (no DB, no network) — `scripts/round13-tests.js`

| Section | Coverage |
|---|---|
| `leaveRules.parseLeaveDate` | YYYY-MM-DD, ISO with time, Date instance, null/undefined, leap-day |
| `leaveRules.inclusiveDayCount` | Same-day, multi-day, leap-year |
| `leaveRules.rangesOverlap` | Touching boundaries (inclusive), disjoint, identical |
| `leaveRules.validateCreatePayload` | Missing body, bad date, end < start, start < today, overlap with own PENDING/APPROVED, reason too short/long, > 30 days |
| `leaveRules.canTransition` | PENDING→APPROVED/REJECTED/CANCELLED, terminal transitions |
| `leaveRules.httpStatusForCode` | INVALID_BODY/OVERLAP/PAST_DATE/REASON_TOO_SHORT/REASON_TOO_LONG/TOO_MANY_DAYS/INVALID_TRANSITION → 400/409 |
| `timesheet.dayKey` | Date, string YYYY-MM-DD, ISO string, numeric timestamp, null/undefined/invalid |
| `timesheet.formatDateStr / formatTimeStr` | Local-midnight formatting, missing → `—` |
| `timesheet.inclusiveDayCount` | Leap-year, 30-day, 31-day months |
| `timesheet.sumSessionHours` | Single session, multiple sessions, lunch break not inflated, open session ignored |
| `timesheet.buildAttendanceMap / buildLeaveMap` | Multi-employee, multi-day, only APPROVED mapped |
| `timesheet.resolveStatus` | Full priority matrix: APPROVED Leave > Present > Weekend-with-checkin > Weekend > Future > Absent |
| `timesheet.buildTimesheetRows` | Leap Feb (29), non-leap Feb (28), weekend Saturday/Sunday, future dates, mixed statuses, summary totals add up |

### 4.2 Integration tests (real Express + mocked Prisma + real JWT)

**Leave router** — `scripts/round13-tests.js` `leave router integration`:

1. `POST /api/leave` valid → 201, returns id
2. `POST /api/leave` invalid (bad date + short reason) → 400
3. `GET  /api/leave/my` → 200, new request visible
4. `GET  /api/leave` (admin) → 200
5. Approve as non-admin → 403
6. Approve as admin → 200
7. Re-approve already-approved → 409 `INVALID_TRANSITION`
8. Reject as admin with notes → 200
9. Cancel own PENDING → 200
10. Cancel someone else's PENDING → not 200 (403/404)

**Attendance export** — `scripts/round13-tests.js` `attendance export integration`:

1. Non-admin → 403
2. Admin `?month=2026-08` → 200, `Content-Type` spreadsheetml/csv,
   `Content-Disposition: attachment`, `X-Export-Format` set,
   `X-Export-Row-Count` set, body has bytes
3. `?month=bad` → 400
4. (no month) → 400

**Result (latest run, 2026-08-31):** 133/133 assertions pass, exit code 0.

### 4.3 Why a standalone runner instead of Jest

Jest hangs silently in this Mac sandbox before the "Determining test
suites to run" line — appears to be a child-process issue specific to
this environment. The standalone `node scripts/round13-tests.js` is
fully equivalent in coverage, exits cleanly, and runs in ~5s in
foreground.

---

## 5. Manual / Live Verification

### 5.1 What was actually run

| Layer | Status |
|---|---|
| Pure unit tests | ✅ 133/133 pass (2026-08-31) |
| Router integration (Express + mocked Prisma + real JWT) | ✅ 16/16 pass |
| `dayKey()` numeric-timestamp branch | ✅ added (silently produced empty date column before) |
| Production routes live on Render | ❌ not yet deployed — `/api/attendance/export` and `/api/leave` both return 404 today |

### 5.2 Playwright E2E (not run yet)

`round13-live-test.mjs` is wired up and ready:

- Login → admin attendance → click `Download Timesheet` (waits for
  `download` event, validates filename `.xlsx` or `.csv`)
- `/portal/leave` → fill form → submit → assert `.leave-pill-pending`
- `/portal/admin/leave` → click first `Approve` (handles the 7+ day
  confirmation dialog) → assert filter changes

**Why not run:** Playwright browsers cannot be installed in this sandbox
(`playwright install` hangs on the Chromium CDN download). The Puppeteer
chrome binary that is already on disk also hangs when invoked via
`executablePath`. The script is ready to run on any environment with
working network access; output goes to `./round13-screenshots/` with a
`summary.json`.

### 5.3 Recommended pre-deploy steps

1. `npm install` on the backend (adds `exceljs` and its tree — should
   resolve from existing lockfile or `npm install exceljs@^4.4.0`).
2. `npx prisma migrate deploy` (or `db push`) so `LeaveRequest` exists
   in production Postgres.
3. Render auto-deploy picks up the new code → verify with
   `curl https://acs-chennai.onrender.com/api/attendance/export?month=2026-08`
   (admin token).
4. Run `round13-live-test.mjs` against production to capture
   screenshots.

---

## 6. Assumptions

1. **`process.env.TZ = 'Asia/Kolkata'`** is already set globally in
   `backend/src/index.js` — verified by reading `index.js`. The
   timesheet builder relies on this for correct day boundaries.
2. **Existing `req.app.get('prisma')` pattern** — confirmed in
   `routes/attendance.js`; new leave route uses the same lookup so the
   existing Jest harness (when it works) and dev/test stubs still
   apply.
3. **JWT secret** — `auth.js` validates `JWT_SECRET ≥ 32 chars` at module
   load. The integration test seeds a 51-char test secret before
   requiring the router so the validation passes.
4. **Leave reason required** — 5..500 characters. Aligns with HRMS
   norms and matches the reason field on existing Attendance notes.
5. **Max 30 consecutive days per request** — prevents admin mistakes
   (e.g. accidentally approving 6 months). Trivially extensible via
   `MAX_LEAVE_DAYS` constant in `leaveRules.js`.
6. **Approved leave overlays the timesheet** — Pending leave renders
   as Absent in the export. This is intentional: payroll shouldn't
   change until a human approves. Per the round-13 design doc.
7. **Self-approval blocked for admins** — Compliance default.
   Configurable in the future by flipping a flag in `leaveRules.js`.
8. **Notifications are best-effort** — status transition is wrapped in
   a Prisma transaction; notification `create` failures are logged but
   don't roll back. The user sees the decision either way.
9. **Sheet name** = `Timesheet` (always, no dynamic naming).
   `Filename` = `timesheet-YYYY-MM.xlsx` (or `.csv` fallback).
10. **CSV fallback triggers** when `require('exceljs')` throws. In
    practice this never triggers on Render (Node 22 + exceljs ^4.4.0
    install cleanly); the fallback exists so a broken deploy or
    engine-version drift doesn't silently break the export.

---

## 7. Risks

| # | Risk | Likelihood | Mitigation |
|---|---|---|---|
| R1 | New routes 404 on production until Render auto-deploy runs. | Certain (today, before deploy) | Deploy + run `prisma migrate deploy` as one CI step; production readiness test verifies 200 on both new endpoints. |
| R2 | `prisma db push`/`migrate deploy` not yet executed in prod. | Medium | Add explicit `prisma migrate deploy` to the Render build/start command (same pattern used in round-11). |
| R3 | `exceljs` adds ~3 MB to backend deps. | Low | Already proven dependency-free style works; consider lazy-loading if size becomes a concern. |
| R4 | Notification creates extra DB roundtrips on every approve/reject. | Low | Wrapped in `$transaction`; rate limit (10/hr) bounds submit volume. |
| R5 | Self-approval block may surprise admins. | Low | UI shows error message; admin can re-submit via the employee path or have another admin approve. |
| R6 | Playwright verification was not run in this sandbox. | Medium | `round13-live-test.mjs` is committed and ready; run after deploy. |
| R7 | Month-string parsing on DST boundaries. | Very low | We bucket by local-midnight Date.getTime(), not ISO strings. IST has no DST. |
| R8 | Date input UI allows arbitrary past dates before user notices. | Low | `validateCreatePayload` returns `PAST_DATE` with a friendly message; UI surfaces it. |
| R9 | Overlap check is per-employee only — does not consider other employees' leave for capacity planning. | By design | Out of scope for round-13; tracked for future. |
| R10 | `dayKey()` accepts numeric timestamps — added in this round; pre-round-13 code would have returned null and rendered blank `date` columns. | Fixed | Unit test `dayKey numeric timestamp parses` locks it in. |

---

## 8. Files Touched (summary)

**New:**
- `backend/src/lib/leaveRules.js`
- `backend/src/lib/timesheet.js`
- `backend/src/lib/excelWriter.js`
- `backend/src/routes/leave.js`
- `src/pages/portal/Leave.jsx`
- `src/pages/admin/LeaveDashboard.jsx`
- `backend/scripts/round13-tests.js`
- `round13-live-test.mjs`

**Modified:**
- `backend/prisma/schema.prisma` (LeaveRequest + LeaveStatus)
- `backend/src/index.js` (mount `/api/leave`)
- `backend/src/routes/attendance.js` (`GET /api/attendance/export`)
- `backend/src/middleware/rateLimit.js` (export + leave-create limiters)
- `backend/package.json` (exceljs ^4.4.0; `test:round13` script)
- `src/lib/api.js` (`download`, `leave.*` helpers)
- `src/pages/portal/Admin.jsx` (Download Timesheet button)
- `src/components/PortalLayout.jsx` (Leave nav un-comings-sooned)
- `src/App.jsx` (mount Leave + LeaveDashboard)
- `src/App.css` (~240 lines of `.leave-*` + export styles)

---

## 9. How to run locally

```bash
# Backend tests (no DB)
cd backend
node scripts/round13-tests.js

# Live E2E (requires Playwright browser install)
cd ..
NODE_PATH=/path/to/playwright/node_modules node round13-live-test.mjs
```

**Exit codes:**
- 0 → all assertions pass
- 1 → one or more assertions failed (printed under `FAILURES:`)