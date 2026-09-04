# Skipped Tests — LPR-004 Inventory

> **Status as of round-26 (LPR-004 closure).** This file tracks every backend
> test suite that is intentionally skipped in the production-boundary
> integration tier. Per the latest SOL production-readiness reassessment
> (LPR-004), the integration suite (`__tests__/integration/`) is now
> protected by the CI guard `scripts/no-skipped-tests.js`, which fails
> the build if a new `.skip(` or `.only(` enters that directory. The unit
> suite (`__tests__/*.test.js`, excluding `integration/`) is allowed to
> contain `.skip(` markers only for the reasons listed below; this file
> is the single source of truth for that allow-list.

## CI guard

`scripts/no-skipped-tests.js` (wired into `npm test` via `pretest`) walks
`__tests__/integration/` and fails if `.skip(` or `.only(` appears in any
file. Re-enabling integration tests is now a contract, not a TODO.

## Un-skipped this round (proof of life)

| File | What was un-skipped | Reason | Reference |
|------|--------------------|--------|-----------|
| `__tests__/dateOnly.test.js` | `dateOnlyToUtc` describe block (1 test) | Pure helper, no Prisma or external deps — verified the implementation matches the assertion before un-skipping. The remaining 30 tests in this file stay `.skip` and are tracked below. | LPR-004 |
| `__tests__/cursor.test.js` | Already enabled (26 tests passing) | DR-008 wire-format regression; was never skipped. Acts as the baseline for "what a clean suite looks like". | DR-008 |
| `__tests__/admin-training-overdue.test.js` | All 20 tests across 3 describes (was: header skipped; was 15 after S3-5) | S3-6: added 5 more tests pinning the silent-miss retry contract (`overdueNotifiedAt` recorded only on `sent > 0`; retry pass picks up null/stale rows; retry meta includes `retry: true`; response exposes `unnotifiedEstimate`). The 15 from S3-5 were the bounded-batch sweep (take / orderBy / per-run cap / time budget / partial-batch short-circuit). | REPORT-S3-6 |
| `__tests__/upload-intent-binding.test.js` | All 12 tests across 3 describes (new file) | S3-7: closes the durable-binding half of the S3-7 finding. Pinned: confirmed intent → `boundType='dpr'\|'inspection'`, `boundAt` stamped; no intent → 400 `UPLOAD_NOT_CONFIRMED` with `photoIndexes`; PENDING/EXPIRED rejected; IDOR (other employee's intent) rejected on both DPR and Inspection POSTs; no-photo path is a true no-op; pre-migration prisma (no `uploadIntent`) degrades gracefully. | REPORT-S3-7 |
| `__tests__/upload-sweep.test.js` | All 14 tests across 5 describes (new file) | S3-7: closes the durable-sweep half. Pinned: auth (404 unset / 403 mismatch), pass-1 PENDING→EXPIRED+deleteBlob, pass-2 CONFIRMED-unbound orphan → EXPIRED+deleteBlob (the silent class), pass-3 EXPIRED-verify+stamp-swept so the pass terminates, per-run cap (`stoppedReason='per_run_max'`), empty DB zeros, 500 when prisma.uploadIntent missing. The pass-1/2 → `boundAt: new Date()` stamp is the load-bearing fix that prevents pass-3 from re-deleting the same rows on the same fire. | REPORT-S3-7 |

## Skipped file inventory (unit suite, not protected by the CI guard)

Every entry below lists the file, the SOL finding that flagged it, and a
one-line reason the suite is still skipped. Re-enable each one in a
focused follow-up PR — do NOT batch-unskip (the existing rationale is
that many of these are blocked on schema/test-env issues that would
break CI if mass-unskipped).

| File | Lines skipped | SOL finding / DR | Why still skipped |
|------|---------------|------------------|--------------------|
| `__tests__/admin-attendance-digest.test.js` | behavior description (header) | LPR-004 / DR-022 | Body uses inline overrides of shared mocks — needs rewrite against the new digest cron contract before it's stable. |
| `__tests__/admin-fanout.test.js` | behavior description (header) | LPR-004 / DR-022 | Same as above — admin-fanout semantics changed in round-25 (per-user preferences). |
| `__tests__/attendance.datebucket.test.js` | header skipped | LPR-004 / DR-023 | Datebucket helper tests for IST; unskip separately after `dateOnly.test.js` finishes its phased re-enable. |
| `__tests__/attendance.session-idempotency.test.js` | `DR-025 — one open session per attendance row` | LPR-004 / DR-025 | Blocked on DR-025 schema migration that hasn't run on the deployed DB. Re-enable when the migration is applied. |
| `__tests__/attendance.test.js` | `Attendance Routes`, `Date Handling`, `GET /api/attendance`, `GET /api/attendance/today`, `POST /api/attendance/check-in`, `IST off-by-one`, `Authentication Middleware`, `Map URL Generation`, `Time Formatting` | LPR-004 | Multiple describes — broad attendance coverage; needs staged re-enable because some sub-tests depend on the live Postgres. |
| `__tests__/attendance.timezone.test.js` | `DR-024 simplified`, `DR-024 — server time` | LPR-004 / DR-024 | DR-024 partially fixed (server time is source of truth). Tests are pinned to the simplified contract — needs spec clarification before they can be re-enabled. |
| `__tests__/dpr.cursor.test.js` | `DR-008 — DPR cursor integration (mounted route)` | LPR-004 / DR-008 | The unit-level cursor tests (`__tests__/cursor.test.js`) pass — only the mounted-route variant is skipped because it requires the test DB schema to mirror production. |
| `__tests__/dpr.stats.test.js` | `DR-029 — /api/dpr/stats`, response shape | LPR-004 / DR-029 | Stats endpoint contract was rewritten in round-19; the test expectations need a refresh. |
| `__tests__/dpr.update.test.js` | `DR-006 — DPR PUT terminal-state`, `DR-006 — DPR PUT status race`, `DR-006 — DPR POST Idempotency-Key` | LPR-004 / DR-006 | Conditional updates implemented but the test harness can't simulate concurrent writes deterministically — needs a SQLite-backed test harness or transaction-fixture helper. |
| `__tests__/inspection.filter.test.js` | `DR-028 — inspection list from/to range filter` | LPR-004 / DR-028 | DR-028 fixed in source; the mounted-route test needs the new test-env seeder. |
| `__tests__/inspection.stats.test.js` | `DR-029 — /api/inspection/stats`, response shape | LPR-004 / DR-029 | Same reason as `dpr.stats.test.js`. |
| `__tests__/inspection.update.test.js` | `DR-004 — Inspection create status gate`, `DR-004 — Inspection PUT allowlist + version phantom` | LPR-004 / DR-004 | Owner edit race (DR-004 partial) — needs read-then-update test fixture that holds a row lock. |
| `__tests__/leave.filter.test.js` | `Leave GET (admin) — DR-009 date-range filter` | LPR-004 / DR-009 | DR-009 partially fixed; the active deployment doesn't run the raw exclusion migration yet. |
| `__tests__/leave.overlap.test.js` | `Leave POST — DR-009 overlap rejection` | LPR-004 / DR-009 | Same as above — overlap logic implemented in source but not exercised against the deployed schema. |
| `__tests__/reportDate.test.js` | `isFutureReportDate`, `getMaxReportDate`, `assertNotFutureReportDate`, mounted POST/PUT for DPR & inspection | LPR-004 / DR-027 | The unit helpers are passing; the mounted-route tests are skipped because they rely on a transactional fixture that the harness doesn't provide. |
| `__tests__/storage.test.js` | `applyR2Cors`, `generateReadSASUrl TTL`, `provisionR2.js`, `_sweepOrphanUploadsCore`, `index.js /ready`, `REQUIRED_BUCKETS`, runSweep | LPR-004 / DR-017 | DR-017 storage fix landed; tests are skipped because the harness mocks the AWS SDK but the round-26 upload-intent refactor (LPR-012) is the next layer they need to assert against. |
| `__tests__/internal-digest.test.js` | header skipped | LPR-004 / DR-022 | Round-25 digest pivot changed semantics; the existing tests assert the pre-pivot contract. |

> **Smoke files** (`smoke_dr005.js`, `smoke_dr017.js`, `diag.removed.test.js`,
> `smoke_dr.js`) are not part of the regular `jest` run; they're executed
> ad-hoc by the round-N scripts. They are excluded from the CI guard by
> design.

## Re-enable playbook

For each row above:

1. Open the linked DR/LPR and verify the production fix is live.
2. Open the file and remove `.skip` from the named describe block.
3. `cd backend && npx jest <file> --silent` and confirm green.
4. Land as its own PR — never batch — so regressions bisect cleanly.
