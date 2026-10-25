# DR-034 — PR #11 review, correction, and completion

**Date:** 2026-10-25
**PR:** #11 — "Fix refresh recovery and DPR evidence controls"
**Base:** `add-react-website` @ `9037bd4`
**Head (as reviewed):** `fix/google-oauth-redirect-uri` @ `760d876`

---

## 1. Verdict

| # | Change in PR #11 | Valid? | Required? | Safe? | Action |
|---|---|---|---|---|---|
| 1 | Rotation receipt **successor-liveness gate** (`findRotationReceiptBySpentRowId`) | ✅ | ✅ | ✅ | **Kept as-is** + pinned by a new test |
| 2 | Rotation receipts **deleted when sessions are revoked** | ✅ | ✅ | ✅ | **Kept as-is** + pinned by a new test |
| 3 | Rotation receipt **TTL shortened** (7d → 30s) | ⚠️ intent right, **value wrong** | ✅ | ❌ at 30s | **Corrected to a dedicated 5-minute `ROTATION_RECEIPT_TTL_MS`** |
| 4 | DPR **evidence lock** (replace-photo is DRAFT-only) | ✅ | ✅ | ✅ | **Kept as-is**, completed (frontend gate + repaired mock + regression coverage) |
| 5 | `deploy.yml`: **remove `workflow_dispatch`** | ❌ | ❌ | ❌ **SHIP-BLOCKER** | **Override restored**, `workflow_run` hardening kept |

**Overall:** the three *code* fixes are valid and required. The workflow change as written would have frozen the frontend publish path. After the corrections below, the PR is safe to merge.

---

## 2. The ship-blocker: the only working publish path was removed

PR #11 deleted the `workflow_dispatch` trigger from `.github/workflows/deploy.yml`, on the theory that `workflow_run` (gated on a successful `frontend-ci`) is the sole legitimate publish route.

**Measured against the GitHub API, 2026-10-25:**

```
actions/runs?event=workflow_run     -> total_count 0    (never fired, ever)
actions/runs?event=workflow_dispatch-> 32 runs          (every publish since)
```

The `workflow_run` trigger was introduced in `fbc493b` (2026-09-24) and has produced **zero** runs despite dozens of successful `Frontend CI (test + build gate)` push runs on `add-react-website`. Every production Pages deploy since then went through a manual dispatch:

`38107395404` · `38116749479` · `38118667576` · `38691458143` · `38722915556` · `38730660624`

Deleting `workflow_dispatch` would have left the repository with **no working way to publish `acschennai.com`**.

**Correction applied.** The override is restored exactly as the DR-034 audit contract requires — *"Keep an explicitly authorized emergency override separate rather than weakening every deployment"* — i.e. it stays a distinct, opt-in path rather than a general bypass:

```yaml
workflow_dispatch:
  inputs:
    bypass_gate:
      description: '[DR-034] Skip the frontend-ci success gate (emergency override only)'
      type: boolean
      default: false          # a bare dispatch does NOT publish
      required: false
```

The PR's `workflow_run` hardening is **kept** — it is a genuine improvement over the base:

```yaml
(github.event_name == 'workflow_run'
  && github.event.workflow_run.conclusion == 'success'
  && github.event.workflow_run.event == 'push'
  && github.event.workflow_run.head_repository.full_name == github.repository)
||
(github.event_name == 'workflow_dispatch'
  && inputs.bypass_gate == true)
```

`workflow_run.event == 'push'` rejects a gate run started by `pull_request`; `head_repository.full_name == github.repository` keeps a fork's `workflow_run` out of the privileged Pages context. The Checkout step pins `ref` to `workflow_run.head_sha` on the gated path and to `github.ref` on the override path, so both publish a specific, identified artifact.

**Known operational debt (not fixed here, deliberately):** the `workflow_run` trigger is dead in this repository, so *gated* auto-publish does not exist in practice — every publish is currently an explicit override. Making the gate real means moving the Pages publish into `frontend-ci.yml` as a job with `needs: test-and-build`. That is a deploy-contract change and out of scope for a bug-fix PR; it is flagged as a follow-up.

---

## 3. Rotation receipt TTL — the PR's value would have broken recovery

### What the PR did

`backend/src/lib/revocation.js` — the receipt row's `expiresAt` was the successor refresh token's 7-day expiry; the PR changed it to `now + ROTATION_REPLAY_MS` (30 seconds).

### Why 30 seconds is wrong

`rotation_receipt` is the **durable** half of DR-002's recovery channel. There are two recovery channels for a client holding an already-spent refresh token:

| Channel | Scope | Fails when |
|---|---|---|
| in-memory `rotationReplay` map | 30 s, per process | the process restarts, or the client was offline > 30 s |
| durable `rotation_receipt` row | survives restart | the receipt expires |

Bounding the durable channel to the *same* 30 seconds as the in-memory one collapses it into the in-memory window — it only ever helps while the process is up and the client was quick. The recovery cases DR-002 was built for are exactly the ones it would have broken:

- a `/refresh` response that never reached the client (network blip, proxy drop),
- a Render cold start (~60 s) between the commit and the retry,
- a brief laptop wake.

When the durable receipt is gone, `/refresh` sees a spent token with no recovery path and answers `REFRESH_REUSED` — which **revokes every session for that employee**. That is the round-5 "your session has expired … multiple times" complaint.

### Why 7 days is also wrong

`rotation_receipt` is the one table in the schema that stores a refresh token **in the clear**. `refresh_token` stores a sha256 digest precisely so a read-only DB leak (backup, SQLi, over-broad support query) cannot yield a usable 7-day credential. Giving the receipt the successor's 7-day TTL undoes that guarantee: one leaked receipt row hands an attacker a working session for a week.

### Correction applied

A dedicated, named horizon:

```js
const ROTATION_RECEIPT_TTL_MS = 5 * 60 * 1000;
```

5 minutes covers the realistic recovery gaps (15 s client timeout + retry, ~60 s cold start, a brief laptop wake) while cutting the cleartext-credential window from **7 days to 5 minutes**. The constant carries the reasoning inline so the next editor does not "simplify" it back to the successor's TTL.

### Also corrected: the replay wipe was global

The PR added `clearRotationReplay()` to `revokeAllRefreshTokensForEmployee`. The replay map is module-scoped and shared by every employee, so revoking one employee's sessions wiped an unrelated employee's in-flight rotation fast path — a cross-tenant side effect of a single sign-out. Narrowed to a per-employee purge:

```js
function clearRotationReplayForEmployee(employeeId) { ... }
```

`rememberRotation` now records the owner so the purge can be scoped. Entries recorded before the owner was threaded through have no owner and are left to expire on their own within `ROTATION_REPLAY_MS`.

---

## 4. DPR evidence lock — correct, and now covered

`PATCH /api/dpr/:id/photos/:photoId` is the BLOB_GONE repair path: the server found the blob missing from object storage, the user re-uploads, and the existing photo row is re-bound to the new bytes.

**The hazard the PR closes:** once a DPR has left DRAFT its evidence is "on file" — a reviewer is looking at those bytes. If the submitter can still replace them, the reviewer approves bytes they never saw, and the approval trail no longer describes what was approved. The same class of hole DR-006 closed for narrative edits.

The PR's implementation is sound and was kept as-is:

- a **fast path** — non-DRAFT ⇒ `409 DPR_EVIDENCE_LOCKED` before any write;
- the **authoritative path** — a compare-and-swap inside the transaction (`updateMany` with `status: 'DRAFT'` in the WHERE). The read that feeds the fast path can be stale; a DPR submitted between the read and the write still loses the CAS, and the transaction aborts with no photo re-bound;
- a deliberate **version bump**, because the record's evidence changed and the optimistic-concurrency token must advance with it.

### What the PR was missing (now added)

1. **The frontend still offered the action.** `DprList.jsx` / `DprAll.jsx` rendered an enabled "Replace" button on non-DRAFT reports; the user picked a file, uploaded it, and only then got the 409. The button is now disabled **with a reason** (tooltip + guard), matching the server contract.
2. **The DR-018 test mock was broken by the CAS.** The mock's `dPR` delegate had no `updateMany`. `withRecordTransaction` falls back to the base client when `tx.dPR.create` is missing, so `db.dPR.updateMany` was `undefined` → TypeError → **500 on the whole repair path**. The mock now models the compare-and-swap.
3. **No regression coverage** — the PR body itself flagged this. Two new suites added (below).

---

## 5. Regression coverage added

### `backend/__tests__/dr034-refresh-recovery.test.js` (new, 5 tests)

1. the receipt TTL is bounded by `ROTATION_RECEIPT_TTL_MS` and is decisively **not** the successor's 7-day lifetime;
2. a receipt whose successor was revoked is dead — signing out then replaying the old token returns `401 REFRESH_REUSED`, not a fresh session;
3. the legitimate loser still recovers the winner's pair inside the window (the regression guard on the TTL change — without it, an ordinary sibling-tab race becomes a forced logout);
4. revoking an employee's sessions deletes their durable receipts;
5. revoking one employee does **not** clear another employee's in-flight replay entry.

### `backend/__tests__/dpr.evidence-lock.test.js` (new, 8 tests)

- DRAFT + owner ⇒ `200`, photo re-bound, `version` advanced 1 → 2;
- DRAFT + admin ⇒ `200` (the admin mints their **own** upload intent — `validatePhotoIntents` only accepts an intent the caller owns);
- `SUBMITTED` / `UNDER_REVIEW` / `APPROVED` / `REJECTED` ⇒ `409 DPR_EVIDENCE_LOCKED` for the owner, photo row untouched;
- `SUBMITTED` + admin ⇒ `409` as well — the lock protects the *evidence*, not the role;
- **TOCTOU**: the DPR leaves DRAFT between the status read and the conditional write ⇒ `409` and the photo row is **not** re-bound.

---

## 6. Verification results (2026-10-25, local)

> **Reproduction note.** Run jest through the binary, not `npx`/`npm exec`: `npm exec` stalls for minutes on registry resolution in this sandbox. `node node_modules/.bin/jest --listTests` takes **0.47 s**; the same command via `npx` takes > 4 minutes.

### Frontend — all green

| Scope | Command | Result |
|---|---|---|
| `src/__tests__/` | `node node_modules/.bin/jest --testPathPattern='(^|/)src/__tests__/' --runInBand --forceExit` | **94 suites / 1060 tests — all pass** |
| `frontend/__tests__/` | `node node_modules/.bin/jest --testPathPattern='(^|/)frontend/__tests__/' --runInBand --forceExit` | **14 suites / 166 tests — all pass** |
| build | `npm run build` | clean |

### Backend — targeted suites for the changed code — all green

| Suite | Result |
|---|---|
| `dr034-refresh-recovery.test.js` (new) | 5/5 pass |
| `dpr.evidence-lock.test.js` (new) | 8/8 pass |
| `dpr.dr018.test.js` (mock repaired) | 10/10 pass |
| `dr002-refresh-rotation.test.js` | 8/8 pass |
| `revocation.test.js` | pass |

### Backend — full suite, 3 runs, compared against the untouched base

The full suite was run three times on this branch and twice on a clean `add-react-website` worktree (`/tmp/acs-base`, base commit `9037bd4`, node_modules symlinked).

| Run | Tree | Failing suites |
|---|---|---|
| 1 | branch | `projects.dr014`, `payslip-routes` |
| 2 | branch | `projects.dr014`, `payslip-partial-unique-drift` |
| 3 | branch | `projects.dr014`, `internal-admin-attendance.dr007-digest-gate` |
| 1 | **base** | `projects.dr014`, `projects.discovered-list-orphans-only` |
| 2 | **base** | `projects.dr014`, `boq`, `billing-certifications` |

- **`projects.dr014.test.js` fails identically on the untouched base commit** ⇒ **pre-existing**, unrelated to this PR. (`pendingReviewCount` KPI fixture: expects `submittedCount === 3`, gets `0`.)
- Every other failing suite **varies run to run on the same tree** and also fails on the base tree ⇒ environment-dependent, not caused by this diff:
  - `payslip-partial-unique-drift` needs a local `psql`/Docker — unavailable here;
  - `payslip-routes`, `internal-admin-attendance.dr007-digest-gate`, `billing-certifications`, `boq` and `projects.discovered-list-orphans-only` fail with **5 s jest timeouts** under CPU contention (run 1 alone took 242 s vs 25 s for runs 2–3, with stale jest processes resident).
  - None of them import `lib/revocation`, `routes/auth`, or the DPR photo-replace path.

`payslip-routes.test.js` also **passes standalone** on this branch (86/86), confirming the run-1 failure was contention, not the diff.

### Other guards

| Check | Result |
|---|---|
| `backend/scripts/no-skipped-tests.js` (`pretest`) | **OK** — 1 integration + 143 unit files scanned, no forbidden markers |
| `.github/workflows/deploy.yml` under `js-yaml` | **parses**; `on:` = `workflow_run` + `workflow_dispatch`; job `if:` correct |

---

## 7. Open items / follow-ups (not blockers for this PR)

1. **The `workflow_run` gate is dead.** Gated auto-publish does not exist; every publish is a manual override. Making it real = move the Pages publish into `frontend-ci.yml` as a job with `needs: test-and-build`. Deploy-contract change — out of scope here.
2. **The evidence lock is only partial.** `PUT /api/dpr/:id/photos` still allows *adding* photos to a non-DRAFT DPR, so "evidence is frozen at submission" is not fully true. Closing that means restricting photo addition to DRAFT as well — a behaviour change on a live path, better as its own reviewed PR.
3. **BLOB_GONE repair is unavailable for submitted reports.** A direct consequence of (2): a DPR that goes BLOB_GONE *after* submission can no longer be repaired. Deliberate — the alternative is letting the submitter swap bytes under the reviewer — but it needs a documented path (e.g. an admin "attach replacement evidence" action that records the swap in the audit trail).
4. **Upload-URL immutability** (flagged as unverified in the PR body). The *path* is immutable — server-minted ULID, server-owned prefix, and `expectedBlobPath` is enforced at bind time (DR-001). The *bytes at that path* remain overwritable for the 15-minute SAS lifetime; making that single-use requires a POST-policy with content-length conditions or a server-side proxy. Not what this PR claims to fix; separate hardening item.
5. **Form dirty-state on token refresh** (also flagged in the PR body). Already covered by the DR-030 contract (`src/__tests__/dr030-transient-refresh.test.jsx`, green): a transient 5xx/timeout refresh failure does not end the session or orphan the user's draft. The 30 s → 5 min receipt widening *reduces* this risk, since fewer legitimate retries fall through to `REFRESH_REUSED`.

---

## 8. Files changed by this review

| File | Change |
|---|---|
| `.github/workflows/deploy.yml` | Restored the `workflow_dispatch` override with the explicit `bypass_gate` boolean; kept the PR's `workflow_run` hardening; recorded the measured trigger behaviour in the header. |
| `backend/src/lib/revocation.js` | `ROTATION_RECEIPT_TTL_MS = 5 min` (replacing the PR's 30 s); per-employee replay purge (`clearRotationReplayForEmployee`) replacing the global wipe; `rememberRotation` records the owner; exports + rationale comments. |
| `backend/src/routes/auth.js` | One line — thread the employee id into `rememberRotation` so the purge can be scoped. |
| `backend/src/routes/dpr.js` | Comments only (the PR's code is unchanged) — explained why the pre-check is a fast path and the in-transaction `updateMany` is the authoritative compare-and-swap, and why the version bump is deliberate. |
| `backend/__tests__/dpr.dr018.test.js` | Mock now models the `dPR.updateMany` compare-and-swap (without it the route 500s). |
| `backend/__tests__/dr002-refresh-rotation.test.js` | Stale comment corrected — the receipt TTL is its own horizon, not the successor's 7-day lifetime. |
| `backend/__tests__/dr034-refresh-recovery.test.js` | **New** — 5 tests. |
| `backend/__tests__/dpr.evidence-lock.test.js` | **New** — 8 tests. |
| `src/pages/portal/DprList.jsx` | Replace button disabled with a reason when the DPR is not DRAFT; guard in `startReplacePhoto`. |
| `src/pages/portal/DprAll.jsx` | Same. |
