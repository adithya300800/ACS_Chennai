# Dashboard Metrics — Round-20 / DR-029

This document is the **contract** between the backend `/api/dpr/stats` and
`/api/inspection/stats` aggregate endpoints and the admin dashboard tiles
that consume them. Any label rename, field rename, or window change MUST
be reflected here in the same PR.

**Bug origin.** Before round-20, both admin dashboards read paginated list
endpoints and used `response.length` as the count. DPR had `limit=20` so
the "Submitted Today", "Pending Review", "Approved", and "Total Active
DPRs" tiles silently capped at 20 records. Inspection had `limit=1` so
"Open", "Filed Today", and "Closed" could never display more than 1, and
"Total Visible" was bounded by 2. The labels also implied date windows
that the requests did not implement — an "Approved" tile showed the first
20 approved rows regardless of when they were approved.

**Fix.** Two new endpoints — `/api/dpr/stats` and `/api/inspection/stats`
— run six targeted `COUNT()` queries against indexed columns using an
explicit `[today UTC, tomorrow UTC)` window. Both are admin-only and
require `requireFreshAdmin` (DR-005) so a stale or demoted admin token
cannot read org totals.

---

## `/api/dpr/stats`

**Auth:** `requireAuth` (via the router-level `router.use(requireAuth)`)
→ `requireFreshAdmin` (DR-005) → handler.

**Method:** `GET`

**Response:**

```json
{
  "submittedToday": 7,
  "pendingReview": 12,
  "approvedToday": 4,
  "rejectedToday": 1,
  "draftCount": 3,
  "totalActive": 22,
  "window": { "start": "2026-09-15T00:00:00.000Z",
              "end":   "2026-09-16T00:00:00.000Z",
              "timezone": "UTC" }
}
```

### Tile contract

| Field           | Tile label (UI)        | SQL / Prisma query                                                       | Window                                |
|-----------------|------------------------|--------------------------------------------------------------------------|---------------------------------------|
| `submittedToday`| Submitted Today        | `WHERE status='SUBMITTED' AND reportDate >= today AND reportDate < tomorrow` | `reportDate` ∈ `[today, tomorrow)` UTC |
| `approvedToday` | Approved Today         | `WHERE status='APPROVED' AND approvedAt >= today AND approvedAt < tomorrow` | `approvedAt` ∈ `[today, tomorrow)` UTC |
| `rejectedToday` | Rejected Today         | `WHERE status='REJECTED' AND reviewedAt >= today AND reviewedAt < tomorrow` | `reviewedAt` ∈ `[today, tomorrow)` UTC |
| `pendingReview` | Pending Review         | `WHERE status IN ('SUBMITTED', 'UNDER_REVIEW')`                          | org-wide (no date)                    |
| `totalActive`   | Total Active DPRs      | `WHERE status IN ('DRAFT', 'SUBMITTED', 'UNDER_REVIEW')`                 | org-wide (no date)                    |
| `draftCount`    | (reserved — not shown in current UI) | `WHERE status='DRAFT'`                                 | org-wide (no date)                    |

### Indexes used

All four `*Today` counts use the `reportDate`-side indexes:

- `DPR @@index([reportDate, id])` — covers `reportDate` range scans.
- `status` equality is folded into the same scan by Postgres planner.
- `approvedAt` / `reviewedAt` are not indexed in the current schema; the
  counts are full-table scans filtered by indexed status. For a typical
  org with <50k DPRs this is well under 100ms. If volume grows, add
  `@@index([approvedAt])` and `@@index([reviewedAt])`.

### Why transition timestamps for `*Today`?

A DPR filed last week can be approved today. A DPR filed today can be
approved tomorrow. Matching the tile label "Approved Today" requires the
**transition** timestamp, not the filing date.

---

## `/api/inspection/stats`

**Auth:** `requireAuth` (via the router-level `router.use(requireAuth)`)
→ `requireFreshAdmin` (DR-005) → handler.

**Method:** `GET`

**Response:**

```json
{
  "openNow": 3,
  "filedToday": 5,
  "closedToday": 2,
  "acknowledged": 1,
  "pendingReview": 4,
  "totalActive": 6,
  "window": { "start": "2026-09-15T00:00:00.000Z",
              "end":   "2026-09-16T00:00:00.000Z",
              "timezone": "UTC" }
}
```

### Tile contract

| Field           | Tile label (UI)   | SQL / Prisma query                                                                  | Window                                       |
|-----------------|-------------------|-------------------------------------------------------------------------------------|----------------------------------------------|
| `openNow`       | Open              | `WHERE status='OPEN'`                                                               | org-wide (no date)                           |
| `filedToday`    | Filed Today       | `WHERE reportDate >= today AND reportDate < tomorrow`                               | `reportDate` ∈ `[today, tomorrow)` UTC       |
| `closedToday`   | Closed Today      | `WHERE status='CLOSED' AND updatedAt >= today AND updatedAt < tomorrow`             | `updatedAt` ∈ `[today, tomorrow)` UTC        |
| `acknowledged`  | Acknowledged      | `WHERE status='ACKNOWLEDGED'`                                                       | org-wide (no date)                           |
| `pendingReview` | (reserved — backend exposes; not shown in current UI tiles) | `WHERE status IN ('OPEN', 'IN_PROGRESS', 'PENDING_VERIFICATION')`     | org-wide (no date)                           |
| `totalActive`   | Total Active      | `WHERE status IN ('OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS', 'PENDING_VERIFICATION')`   | org-wide (no date)                           |

### Indexes used

- `InspectionRecord @@index([reportDate, id])` — covers `filedToday`.
- `status` equality filter on a non-indexed column. Same caveat as DPR:
  fine for current volume, add `@@index([status])` if a production slow
  query surfaces.

### Why `updatedAt` for `closedToday`?

Inspection records do not have a dedicated `closedAt` column. The close
transition sets `status='CLOSED'` + `updatedAt=now` inside a `$transaction`,
so `updatedAt` is the most reliable proxy. A re-edit on a CLOSED row
would bump `updatedAt` again — accepted; the label is "Closed Today",
not "Closed and never re-edited".

### Why exclude `ACKNOWLEDGED` from `pendingReview`?

`ACKNOWLEDGED` is the "I've seen it" state — the admin has triaged the
record but hasn't started work yet. The bulk-review UI (B-06) accepts
`OPEN / IN_PROGRESS / PENDING_VERIFICATION` as starting points, matching
the backend's `ACK_FROM` / `REJECT_FROM` sets; this tile mirrors the same
boundary so the number means "rows an admin can act on next" without
double-counting acknowledged-but-not-started records.

---

## Window semantics

- All `*Today` windows are UTC `[today, tomorrow)`.
- `start` and `end` are echoed in the response so the UI can render an
  "as of <ts>" subtitle if desired, and so a clock-skew between the
  frontend and the DB is visible in support tickets.
- The date column (`reportDate`) is `@db.Date` in Postgres, so the time
  portion is not stored. `gte: today, lt: tomorrow` covers the entire
  calendar day regardless of which timezone the engineer's row was filed
  from.
- Transition timestamps (`approvedAt`, `reviewedAt`, `updatedAt`) are
  `DateTime` columns — they store the exact UTC instant the transition
  ran, regardless of which day the report was filed on.

---

## Failure modes

| HTTP status | Cause                                       | UI handling                                  |
|-------------|---------------------------------------------|----------------------------------------------|
| 200         | Success                                     | render numbers                               |
| 401         | Missing / invalid Bearer token              | `api.js` interceptor dispatches `auth:logout`|
| 403         | Token valid but `isAdmin=false`             | tile shows zeros + an "admin required" hint  |
| 503         | Prisma unreachable OR admin-check failed    | tile shows "—" + Retry button                |
| 500         | Unmapped Prisma / unknown error             | tile shows "—" + a toast                     |

---

## Change procedure

1. Rename the field on the backend (`backend/src/routes/{dpr,inspection}.js`).
2. Update the matching tile in `src/pages/admin/{Dpr,Inspection}Dashboard.jsx`.
3. Update this document.
4. Update `backend/__tests__/{dpr,inspection}.stats.test.js` `expectedFields`
   array AND its assertion messages.
5. Land in a single commit; CI must pass.

If the change touches the **window** (not just labels), also update the
test's `PINNED_NOW` constant and the seed data so the assertions still
exercise the boundary.
