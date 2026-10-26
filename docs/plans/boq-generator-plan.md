# BOQ Generator — Implementation Plan (v1 — 2026-10-26)

**Status: PLANNING ONLY.** Nothing in this plan has been implemented. No code, no
migrations, no buckets, no tokens, no deploys, no commits.

**Repo:** `/Users/adithyamohanavel/Documents/Repo/ACS_Chennai` (portal)
**Service repo (read-only):** `/Users/adithyamohanavel/Documents/Repo/ACS_Chennai_BOQ`

**What this document is for:** you approve or change it. Implementation starts only
after your approval, and only then.

---

## 0. Executive summary — what you are approving

A new **BOQ Generator** page in the employee portal, under a new sidebar group
**"Tools"**, placed directly under **"My Reports"**. An employee picks civil
drawings (IFC, DXF), confirms the drawing scale, sends them to the existing
BOQ microservice, reviews the generated Bill of Quantities line by line,
corrects lines with a written reason, and saves/downloads the result.

**The three decisions that need your answer before anything is built:**

1. **The service currently serves SAMPLE data.** Its rates and coefficients are
   invented placeholders because ACS has not supplied the real Schedule of Rates.
   It will still return a total. The plan treats this as a hard gate (§2, D1).
2. **Pilot or company-wide?** While the data is SAMPLE, the plan recommends the
   page is restricted to a named pilot cohort + admins, switchable by one env
   var (§2, D8).
3. **Scale is per job, not per drawing, in the service.** Two DXFs at different
   plotting scales in one job would be silently wrong. The plan captures scale
   per drawing and splits jobs by scale (§2, D7).

**Rough size:** 8 small commits, ~2 weeks of one engineer, 2 tables, 1 new R2
bucket, 1 new backend route file, 1 new frontend page. Details in §10.

---

## 1. Findings (Step 1)

### 1.1 Navigation — where "My Reports" lives and how a "Tools" group is added

| Fact | Evidence |
|---|---|
| The sidebar is one array: `navGroups` in [PortalLayout.jsx:280-416](../src/components/PortalLayout.jsx#L280-L416). Each group is `{ label, items: [{ to, label, icon }] }`. | source |
| Group order today: `My Work` → `My Reports` → *(admin only)* `Review` → `Records` → `Administration`. | [PortalLayout.jsx:281-415](../src/components/PortalLayout.jsx#L281-L415) |
| The admin groups are appended by a spread: `...(employee?.isAdmin ? [ Review, Records, Administration ] : [])`. A group inserted **before** that spread therefore shows for employees and admins alike. | [PortalLayout.jsx:347](../src/components/PortalLayout.jsx#L347) |
| Icons are inline SVG `const`s declared at the top of the same file (e.g. `DOC_ICON`, `CHART_ICON`, `LIST_ICON`, `REPORT_ICON`, `BUILDING_ICON`, `BILLING_ICON`, `PAYSLIP_ICON`). | [PortalLayout.jsx:140-278](../src/components/PortalLayout.jsx#L140-L278) |
| Active state is `NavLink`'s own `isActive`; each link carries `title` + `aria-label` for the icon-only collapsed mode. | [PortalLayout.jsx:486-507](../src/components/PortalLayout.jsx#L486-L507) |
| Routes live in [App.jsx:177-345](../src/App.jsx#L177-L345) under `<Route path="/portal" element={<PortalLayout/>}>`. Page components are lazily imported. | source |
| **Mobile does not use a separate menu.** The same `navGroups` array renders in a slide-in drawer (`portal-sidebar mobile-open`) below 768px. The bottom tab bar is a **hardcoded list of 5 links** (Attendance, DPR, Inspection, Leave, Training) and is not data-driven — so "Tools" does **not** appear there unless we deliberately add it. | [PortalLayout.jsx:562-610](../src/components/PortalLayout.jsx#L562-L610) |

**How "Tools" gets added (the whole change):**

```jsx
// src/components/PortalLayout.jsx — insert BETWEEN the "My Reports" group
// (ends line 345) and the admin spread (starts line 347):
{
  label: 'Tools',
  items: [
    { to: '/portal/boq-generator', label: 'BOQ Generator', icon: BOQ_GENERATOR_ICON },
  ],
},
```

Plus one new SVG const. Proposed glyph — a calculator (quantity × rate), chosen
because it is visually distinct from `CHART_ICON` (BOQ Variance), `LIST_ICON`
(BOQ Registry) and `DOC_ICON`:

```jsx
const BOQ_GENERATOR_ICON = (
  <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2"
       strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
    <rect x="4" y="2" width="16" height="20" rx="2" />
    <rect x="7" y="5" width="10" height="4" rx="1" />
    <circle cx="8.5" cy="13" r="1" /><circle cx="12" cy="13" r="1" /><circle cx="15.5" cy="13" r="1" />
    <circle cx="8.5" cy="17" r="1" /><circle cx="12" cy="17" r="1" /><circle cx="15.5" cy="17" r="1" />
  </svg>
);
```

Mobile needs **no change**: the drawer renders the same groups.

### 1.2 Auth and roles — who should see and use this page

- The role model is a **single boolean**: `Employee.isAdmin`. There is no role
  table, no designation-based permission, no per-feature flag today.
  ([schema.prisma:22-46](../backend/prisma/schema.prisma#L22-L46))
- `useAuth()` exposes `isAdmin`; the sidebar gates admin groups on it.
- **Project scoping for employees:** an employee may act on a project **iff an
  active `ProjectAssignment` row exists** for it. This is deliberate: the
  S7/ISRO-LEAK fix made the scope an *intersection* with the assignment
  roster, so history-based discovery alone no longer grants access.
  ([projects.js:700-800](../backend/src/routes/projects.js#L700-L800))
- **Recommendation (to confirm):** the page is visible to **every employee**
  who has at least one assigned project — same visibility rule as the existing
  "My Reports" group. Admin sees it too. Optionally gated to a pilot cohort
  while the data is SAMPLE (§2, D8).
- An employee with **no** assigned projects sees the page but with an empty
  state pointing at the admin who allocates projects — not an error.

### 1.3 Files today — how R2 is used

| Fact | Evidence |
|---|---|
| R2 is accessed with the S3-compatible AWS SDK: `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`. One process-wide singleton client. | [blobStorage.js:1-40](../backend/src/lib/blobStorage.js#L1-L40) |
| **One credential set today:** `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`. Endpoint is `https://<account>.r2.cloudflarestorage.com`, region `auto`. | [blobStorage.js:22-38](../backend/src/lib/blobStorage.js#L22-L38) |
| **Five buckets**, each overridable by env var: `dpr-photos` (`R2_BUCKET_DPR_PHOTOS`), `dpr-documents`, `inspection-photos`, `training-materials`, `db-backups`. | [blobStorage.js:381-397](../backend/src/lib/blobStorage.js#L381-L397) |
| `generateUploadSASUrl(container, employeeId, ulid, contentType, { pathPrefix })` → key `${pathPrefix}/${employeeId}/${ulid}.${ext}`, **PUT only**, **15-minute** expiry. It binds `ContentType` in the signature. | [blobStorage.js:126-154](../backend/src/lib/blobStorage.js#L126-L154) |
| `generateReadSASUrl(container, blobName)` → GET presign, **1 hour** default, overridable by `R2_READ_URL_TTL_SECONDS` (max 24h). | [blobStorage.js:156-193](../backend/src/lib/blobStorage.js#L156-L193) |
| `CONTENT_TYPE_EXT` maps content-type → extension and **throws** on an unknown type. DXF/IFC are **not** in it today. | [blobStorage.js:78-107](../backend/src/lib/blobStorage.js#L78-L107) |
| `mountUploadRoutes(router, config)` is the shared upload contract: `/sas-url` + `/confirm-upload`, with `allowedContainers`, `allowedTypesPerContainer`, `maxSizeBytesPerContainer`, and per-container path prefixes. Caps today: 10 MB photos, 25 MB documents. | [uploadRoutes.js:93-175](../backend/src/lib/uploadRoutes.js#L93-L175) |
| `verifyBlobExists` returns a three-state `present / absent / unknown`; `absent` (HTTP 404) is the only safe "definitively missing" signal. | [blobStorage.js:195-240](../backend/src/lib/blobStorage.js#L195-L240) |
| **There is no magic-byte sniffer in `blobStorage.js` today.** `verifyBlobMagicBytes` does not exist — it was proposed in the payslip plan but not implemented. | verified |
| Bucket CORS + bucket creation are done by `backend/scripts/provisionR2.js` using an **admin-capable** credential: methods `PUT, GET, HEAD`, `AllowedHeaders: ['*']`, `ExposeHeaders: ['ETag']`, `MaxAgeSeconds: 300`. | [provisionR2.js:172-178](../backend/scripts/provisionR2.js#L172-L178) |
| The runtime credential is deliberately **least-privilege** — `PutBucketCors`/`CreateBucket` moved to the IaC script so the runtime key needs only object permissions. CORS self-heal is behind `R2_CORS_SELF_HEAL=true` and is a no-op in production. | [blobStorage.js:425-460](../backend/src/lib/blobStorage.js#L425-L460) |

**Upload UX patterns already in the portal**

- `src/lib/blobUpload.js` — the browser-side helper.
- DPR / inspection photos and project attachments: browser picks a file → `POST /sas-url`
  → browser `PUT`s straight to R2 → `POST /confirm-upload` → server verifies the
  blob exists and the byte length matches exactly (0-byte tolerance) →
  the upload intent is bound to the record.
- The payslip flow (round 35) and the project-attachment flow (round 35) both
  follow it. The upload phase machine is `idle → sas → uploading → confirming → idle`
  with a live percentage. ([MyProjectReports.jsx:141](../src/pages/portal/MyProjectReports.jsx#L141))
- **Download pattern:** `GET /:id/read-sas` mints a 1-hour GET URL and the browser
  opens it. When the blob is gone the server answers `410 { error: 'GONE', code:
  'PAYSLIP_BLOB_GONE' }` — an established contract to copy.
  ([payslip.js:587-590](../backend/src/routes/payslip.js#L587-L590))
- Orphan cleanup is a **reference-aware sweep**: `backend/src/routes/internal-upload-sweep.js`,
  driven by `.github/workflows/cron-upload-sweep.yml`. It deletes blobs nothing
  references — a new BOQ upload path must register its references or the sweep
  will eat them.

**Can project attachments be a source of drawings?** Yes, and it should be the
primary path — the user should not re-upload a drawing the project already has.

- `ProjectAttachment` already carries a nullable `category` enum, whose values
  include **`DESIGN_DRAWINGS`** and **`COST_BOQ`**.
  ([schema.prisma:1405-1414](../backend/prisma/schema.prisma#L1405-L1414))
- `blobPath` is stored verbatim and `read-sas` re-mints a GET URL for it.
  ([schema.prisma:1416-1470](../backend/prisma/schema.prisma#L1416-L1470))
- Caveat: today's attachments live in the `dpr-documents` bucket and the
  `DESIGN_DRAWINGS` category is currently used for **PDF drawings**. DXF/IFC
  attachments do not exist yet. So "pick an existing drawing" works for PDFs
  (which the BOQ service **refuses**) but will only become useful for DXF/IFC
  once such files are uploaded through a drawing workflow.

### 1.4 Data — the Project model and what a BOQ job can hang off

- `Project`: `id` (uuid), `name` (unique), `code`, `client`, `location`,
  `parties` (JSONB), `contractValue` (Decimal 15,2), `sites` (JSONB),
  `description`, `isActive`, `startDate`, `expectedEndDate`, `createdById`,
  timestamps. ([schema.prisma:1092-1130](../backend/prisma/schema.prisma#L1092-L1130))
- `ProjectAssignment`: `(projectId, employeeId)` unique, plus `role`, `assignedAt`,
  `assignedById`. **This is the authorization primitive.** ([schema.prisma:1185-1200](../backend/prisma/schema.prisma#L1185-L1200))
- `Employee`: `id`, `email` (unique), `name`, `designation`, `department`,
  `isAdmin`, `createdAt`, `updatedAt`. (`designation`/`department` are free text
  and are **not** a permission system.)
- **`BoqItem` is not related to this feature.** It is a hand-entered
  contract-vs-executed register (`projectName`, `itemCode`, `unit`, `quantity`,
  `rate`, `amount`) with its own `/api/boq` routes, its own admin registry page
  and a "BOQ Variance" page at `/portal/boq`. It is created only by
  `POST /api/boq` — a manual admin entry. **There is no import path into it and
  this plan will not build one.** The generated BOQ lives in a parallel universe
  with its own tables. The UI must say so, or users will conflate them.
- The `DocumentCategory` classifier (`round 43`) is independent of the report
  `type` and of `status`; `category` is nullable and legacy rows are unaffected.

### 1.5 Existing UI building blocks to reuse

| Component | What it gives us |
|---|---|
| `src/components/ui/FilterChip.jsx` | Pill filter chip, `label` / `active` / `onClick` / `disabled`, `aria-pressed`. |
| `src/components/StatusBadge.jsx` | Shared badge with a `DEFAULT_STATUS_MAP` (DPR/inspection/leave/training tones) and an optional custom `map` prop — **the new page passes its own `map`**, it does not extend the default. |
| `src/components/RecordStatusBadge.jsx`, `SeverityBadge.jsx` | Record and severity tones. |
| `src/components/Modal.jsx` | Modal. (The correction panel uses a **modal on mobile and a side drawer on desktop** — same component, different placement.) |
| `src/components/PageLoader.jsx` | Page-level loading. |
| `src/components/ToastContext.jsx` | `useToast()` → `{ push, dismiss }`. `push` returns a toast id; `dismiss(id)` closes it. A no-op provider is returned outside the tree so tests never crash. |
| `src/lib/api.js` | `apiFetch` wrapper with a **30 s default timeout**, single-flight refresh, `ApiError { status, code, extra }`, transient-network classification (`TIMEOUT`, `NETWORK_ERROR`). **The 30 s default is too short for the BOQ service** (§5). |
| `src/lib/scopeCopy.js` | Pure helpers for honest empty-state copy (the "no data" vs "no data for this filter" distinction). |
| `src/lib/blobUpload.js` | Browser-side R2 upload helper. |
| Tables | Every list page uses a `dpr-card` / `mpr-card` card-per-row layout with inline styles and CSS custom properties (`--brand`, `--steel`, …). The **card-per-row** pattern is already the mobile answer — there is no separate mobile table variant to build. |
| Empty states | Hand-written per page, using `scopeCopy` so the copy never lies about an empty filter. |
| Banners | There is **no shared `Banner`/`Alert` component.** Each page writes its own full-width block (see the partial-failure banner in [MyProjectReports.jsx:1070-1140](../src/pages/portal/MyProjectReports.jsx#L1070-L1140)). The new page writes its own SAMPLE banner in the same style — consistent with the codebase rather than introducing a new primitive. |
| Skeletons | None. Pages use the "Loading…" centred div (e.g. `MyProjectReports.jsx:764-766`). The new page follows suit. |
| Mobile table pattern | Cards, not tables. The BOQ review screen uses one card per line on mobile, one table row on desktop. |

### 1.6 CI state — is the known failing test still blocking?

**No. It is fixed and the backend suite is green.**

- The previously-red backend suite was fixed in PR #12 (commit `83f8a2e`,
  "DR-034: unblock the backend deploy — fix the two red CI suites"), merged as
  `ce394a7`.
- The merge push re-triggered `backend-deploy.yml`; the "Run tests" step
  passed on the runner with **1715 passed / 0 failed**, identical to the local
  run. This is recorded in the merge commit `1757675` and in
  `verification/2026-10-25-dr034-pr11-review/REPORT.md`.
- Current branch `docs/verification-report` is at `1757675`, which is **after**
  `ce394a7`, so the fix is present.
- Workflows: `backend-deploy.yml` runs `npm test` in `backend/` (with
  `THROW_AWAY_DATABASE_URL` pointed at the CI Postgres so the real-DB suites
  actually run). `frontend-ci.yml` runs
  `npx jest --testPathPattern='(^|/)src/__tests__/' --runInBand --forceExit`.
- **Project rule, still in force:** never run `npx jest` locally — use
  `node node_modules/.bin/jest`. (`backend/` uses `npm test`, which is fine.)

### 1.7 The BOQ service — how it actually works

> Everything below is from the service repo's **code**, not its prose. Where the
> two disagree, the code wins and the disagreement is called out (§1.7.9).

#### 1.7.1 The endpoints (10, all under the service base URL)

| Method | Path | Auth | Success | Notes |
|---|---|---|---|---|
| GET | `/health` | **no** | 200 | `{status, production_mode, data_status, data_status_notes[], worker, storage, converter, build_commit}`. Always 200. |
| GET | `/health/ready` | **no** | 200 | DB reachability + cached reader self-test. |
| GET | `/meta` | yes | 200 | Capabilities, limits, data status, SOR sources, WBS groups. |
| POST | `/jobs` | yes | **202** | Submit drawings. `Location: /jobs/{id}`. |
| GET | `/jobs/{id}` | yes | 200 | Status + timestamps + error. 404 `JOB_NOT_FOUND`. |
| GET | `/jobs/{id}/boq` | yes | 200 | BOQ JSON, corrections applied. 409 `JOB_NOT_READY` / `JOB_FAILED`. |
| GET | `/jobs/{id}/snapshot` | yes | 200 | Versioned self-contained document. Same 409s. |
| GET | `/jobs/{id}/boq.xlsx` | yes | 200 | Workbook, 3 sheets, `Content-Disposition: attachment; filename="boq-{id}.xlsx"`. |
| PATCH | `/jobs/{id}/lines/{line_id}` | yes | 200 | One reviewer correction. |
| DELETE | `/jobs/{id}` | yes | 200 | Deletes the job, its files, its corrections **and its idempotency key**. |

- **Auth:** `Authorization: Bearer <token>`, constant-time compare over SHA-256.
  `BOQ_API_TOKEN` and `BOQ_API_TOKEN_NEXT` are both accepted (rotation
  overlap), each with its own rate-limit bucket. Without a configured token
  the service **refuses to start**; `BOQ_API_DEV_MODE=1` is the only escape,
  and even then a configured token is still required.
- **No CORS on the service.** It is server-to-server only. The browser never
  talks to it directly.
- **Every response carries `X-Request-ID`**; send your own (≤128 chars) and it
  is echoed back.

#### 1.7.2 The job lifecycle

`queued → running → done` or `queued → running → failed`. **Exactly four
status strings**, lowercase: `queued`, `running`, `done`, `failed`.

- The worker is a **daemon thread in the same process**, polling every 1.0 s
  and processing **one job per poll cycle**. Jobs queue behind each other.
- There is **no per-job timeout** in the code and **no progress/step endpoint**.
  The only progress signal is the status string plus three timestamps.
  (The service's own smoke test allows up to 600 s of polling.)
- **There is no "list my jobs" endpoint.** The portal must track job ids itself.
- A job killed by a process restart is marked `failed` with
  `error.code = "JOB_INTERRUPTED"` and `retryable = true` — **only if the
  SQLite file survived**. On Render's free plan it usually did not, so the
  honest answer is `404 JOB_NOT_FOUND`.

#### 1.7.3 The response shapes (two different BOQ shapes — this matters)

`GET /jobs/{id}/boq` returns:

```jsonc
{
  "job_id": "...", "name": "...", "project_ref": "...",
  "currency": "INR",              // hard-coded
  "total": 12345.67,              // sum of the ROUNDED per-line amounts
  "data_status": "SAMPLE",        // REAL | DRAFT | SAMPLE
  "data_status_notes": ["..."],
  "used_sample_rates": true,
  "groups": [ { "group_code": "RCC", "group_name": "Reinforced concrete",
                "items": [ { "line_id": "...", "item_code": "RCC-01", "level": "Ground Floor" } ] } ],
  "items": [ { /* the lines — see below */ } ],
  "materials": [ { "material": "cement", "qty": 12.5, "unit": "kg",
                   "wastage_pct": 5.0, "qty_with_wastage": 13.125, "item_codes": ["RCC-01"] } ],
  "derivations": [ /* per-line coefficient rollups */ ],
  "withheld_count": 3,
  "withheld_by_reason": { "SAMPLE_RATE_BLOCKED": 2, "WBS_UNMAPPED": 1 },
  "withheld": [ { "description": "...", "reason_code": "NO_CANDIDATE_IN_ANY_SOURCE",
                  "qty": 1.0, "unit": "cum", "detail": "...", "item_code": "RCC-09" } ],
  "corrections": [ /* the whole trail, oldest first */ ],
  "links": { "self": "...", "boq": "...", "boq_xlsx": "...", "snapshot": "..." }
}
```

A line (`items[]`) carries:

```jsonc
{
  "seq": 1,
  "line_id": "2f8c1d40b6a95e37",     // stable address = derived from item code + level
  "level": "Ground Floor",           // "" when the drawing names no storey
  "group_code": "RCC", "group_name": "Reinforced concrete",
  "item_code": "RCC-01", "description": "...",
  "unit": "cum", "qty": 12.3456, "qty_rounded": 12.346,
  "base_rate": 1000.0, "rate": 1050.0, "amount": 12963.3,
  "rate_source": "TN_PWD_SOR", "sor_code": "05.001.02", "sor_chapters": ["05"],
  "match_tier": "exact_code",
  "reason_codes": ["GEOMETRY_COMPUTED", "EXACT_CODE_HIT"],
  "alternatives": [ { "code": "...", "description": "...", "unit": "cum", "rate": 1.0,
                      "source": "...", "score": 0.91 } ],
  "confidence": { "value": 1.0, "factors": [] },
  "element_ids": ["..."], "source_group": "", "derived_from": null,
  "corrections": [ ... ], "original": { "qty": 12.3456 }, "corrected": false
}
```

**Three shape facts that will bite if missed:**

1. `/boq` returns **`items[]`**; `/snapshot` returns **`lines[]`**. They are
   different documents with different line fields.
2. **There is no `flags` key in `/boq`** — the field is `reason_codes`. The
   `flags` key appears **only** in snapshot lines, as a duplicate of
   `reason_codes`.
3. **Groups are flat, one level.** `groups[].items[]` carries only
   `line_id`, `item_code`, `level` — **no quantities**. Quantities live in
   `items[]`. Chapters are `sor_chapters[]` on the line; there is no nested
   chapter/section tree.

#### 1.7.4 Match tiers and reason codes

**Match tiers — exactly four strings:** `exact_code`, `matched`,
`needs_review`, `unmatched`.

**Job-level error codes** (on `GET /jobs/{id}` → `error.code`):
`JOB_INTERRUPTED` (retryable), `SOURCE_UNCALIBRATED`, `PRODUCTION_DATA_BLOCKED`,
`INTERNAL_ERROR`.

**HTTP error codes** (in the envelope `{"error": {"code", "message", "details"}}`):
`AUTH_REQUIRED`, `VALIDATION_ERROR`, `NOT_FOUND`, `JOB_NOT_FOUND`,
`UNSUPPORTED_FILE_TYPE`, `PDF_NOT_SUPPORTED`, `UPLOAD_TOO_LARGE`,
`REQUEST_TOO_LARGE`, `PRODUCTION_DATA_BLOCKED`, `JOB_NOT_READY`, `JOB_FAILED`,
`INVALID_STATE` (defined but **never raised** — dead code), `CORRECTION_REFUSED`,
`RATE_LIMITED`, `IDEMPOTENCY_CONFLICT`, `TOO_MANY_SOURCES`, `INTERNAL_ERROR`,
and twelve `FETCH_*` codes (`FETCH_URL_INVALID`, `FETCH_SCHEME_REFUSED`,
`FETCH_HOST_REFUSED`, `FETCH_ADDRESS_REFUSED`, `FETCH_REDIRECT_REFUSED`,
`FETCH_TIMEOUT`, `FETCH_STATUS_ERROR`, `FETCH_TOO_LARGE`, `FETCH_HASH_MISMATCH`,
`FETCH_SIZE_MISMATCH`, `FETCH_NOT_CONFIGURED`, plus `FETCH_*` variants).

`details` is an **object** in the HTTP envelope but a **list of strings** in the
job record's `error`. The portal's mapper must read both defensively.

#### 1.7.5 Corrections

`PATCH /jobs/{id}/lines/{line_id}`, body:

```jsonc
{
  "kind": "override_qty",        // | override_rate | reclassify | pick_alternative
  "reason": "checked by hand on site",   // REQUIRED
  "requested_by": "portal-abc",          // REQUIRED
  "qty": 12.5                  // override_qty
  // "rate": 1050              // override_rate
  // "item_code": "RCC-02"     // reclassify
  // "alternative_code": "...", "alternative_source": "..."   // pick_alternative
}
```

- A correction is **append-only** and is **applied at read time**; the computed
  BOQ is never rewritten. The original value stays visible (`original` /
  `corrected` on the item).
- A `reclassify` that would change the **unit basis** is **refused**
  (`CORRECTION_REFUSED`).
- Changing a quantity **re-rolls the materials** and re-derives the derived lines.
- A **404 `NOT_FOUND`** (with `details.available` = the list of valid line ids)
  comes back if the `line_id` is unknown — which is what happens if the service
  restarted and the line ids no longer exist.
- A correction never re-runs the pipeline; there is no "needs review" state.

#### 1.7.6 The snapshot — the document the portal must keep

`GET /jobs/{id}/snapshot` → `schema_version: "1.0"`, `kind: "acs.boq.snapshot"`.

Top level: `run{}`, `data_status`, `data_status_notes[]`, `used_sample_rates`,
`sor_sources[]`, `converter{}`, `inputs[]` (each with `name`, `type`,
`size_bytes`, `sha256` — **never a URL**), `scale{}`, `lines[]`, `materials[]`,
`derivations[]`, `withheld[]`, `totals{currency, amount, line_count,
withheld_count}`, `corrections[]`.

`scale{}` is `{value, denominator, confirmed_by, suggested, source}` where
`source` is `"confirmed"` or `"none"`.

The snapshot is self-contained, deterministic for the same inputs, and is the
document the portal persists. The service's own copy is purged after 168 h; on
Render free the whole SQLite file may vanish sooner.

#### 1.7.7 Reviewer-confirmed drawing scale

- Field: **`dxf_scale`**, a **denominator** as a number — `100` means 1:100.
  It is `float | None`; `None` means *no scale confirmed*. The only validation
  is `> 0`. There is no enumeration of permitted scales.
- It is one value **for the whole job** — see §2, D7.
- A DXF job without one **fails**: the job's `error.code` becomes
  `SOURCE_UNCALIBRATED` and `error_details` names the offending files.
  A drawing whose **units are unknown** is refused the same way.
- `scale_suggestion` is the **layer map's** scale, reported separately and
  **never applied automatically**.

> ⚠️ **The layer map is sample data.** `data/layer_maps/sample_layers.SAMPLE.yaml`
> has `scale: 1`, and the file itself says: *"The value below is the synthetic
> test drawing's own scale, not a claim about ACS Chennai's drawings."* So in
> the current deployment **`scale_suggestion` is `1`**, which is meaningless for
> any real ACS drawing. **The portal must not show `1` as a suggestion.** See
> §3, the settings screen, and §8.

#### 1.7.8 Limits and behaviours that shape the UX

| Limit | Value |
|---|---|
| Max single upload | 100 MB (`BOQ_API_MAX_UPLOAD_BYTES`) |
| Max request body | 110 MiB (`BOQ_API_MAX_REQUEST_BYTES`) |
| Max fetch size | 100 MB (`BOQ_API_FETCH_MAX_BYTES`) |
| Max files per job | 20 (`BOQ_API_MAX_SOURCES`) |
| Rate limit | 240 requests / 60 s, **per token**, sliding window, in-process (resets on restart) |
| Idempotency key | ≤ 256 chars |
| Fetch connect / total timeout | 5 s / **60 s** (`BOQ_API_FETCH_*`) |
| Job retention | 168 h (7 days) |
| Upload retention | 24 h |
| Storage mode | `ephemeral` |
| Cold start | ~1 min to wake; **the container reloads SAMPLE data on every cold start** |

**File type is decided by content sniffing, not by extension.**
`%PDF-` → PDF (refused, `PDF_NOT_SUPPORTED`). `AutoCAD Binary DXF` → DXF.
`ISO-10303-21` → IFC. ASCII DXF (`0` then `SECTION`) → DXF. Anything else →
`UNSUPPORTED_FILE_TYPE`. **DWG is not supported at all.**

#### 1.7.9 Where the service's docs disagree with its code — and with your brief

| # | Claim | Reality |
|---|---|---|
| 1 | README:5 "**Input:** PDF, DXF, IFC." | **PDFs are refused** with `PDF_NOT_SUPPORTED`. PDF is not an input. (The README contradicts itself at lines 250 and 406.) |
| 2 | Your brief: "PDF is *coming soon*" | **Correct** — the service refuses PDFs today. The UI must say so *before* the user picks a file, not after the upload fails. |
| 3 | Your brief: "DWG" in the supported list | **DWG is not supported.** It must be converted to DXF (LibreDWG or the ODA File Converter) first. The UI must say this. |
| 4 | Your brief: "`UNKNOWN_LEVEL`" | **No such constant exists anywhere in the repo.** The nearest is the reason code **`UNKNOWN_STOREY`** (surfaced in `confidence.factors`), and `level` is the **empty string** when the drawing names no storey. The plan uses `UNKNOWN_STOREY` and adds an explicit "level not stated" label for `level === ""`. |
| 5 | Your brief: "reason codes" | There are **~35** of them across five families (quantity source, WBS, rate match, coefficient, geometry/DXF). The full table with plain-language wording is §3.4. |
| 6 | README error list | **Incomplete** — omits `JOB_NOT_FOUND`, `RATE_LIMITED`, `IDEMPOTENCY_CONFLICT`, `REQUEST_TOO_LARGE`, `TOO_MANY_SOURCES` and all twelve `FETCH_*` codes; and lists `INVALID_STATE`, which is **never raised**. |
| 7 | README `PORT` default 8000 | The Docker image uses **10000**. |
| 8 | README "The database ships empty" | True of the git tree, but **the container loads SAMPLE data on every cold start**, so `data_status` is always `SAMPLE` in the current deployment. |
| 9 | `SOURCE_UNCALIBRATED` as an HTTP error | It is a **job-level** error code on `GET /jobs/{id}`, not an HTTP envelope code. The portal maps it from the job record. |
| 10 | `RESULT-SNAPSHOT.md` example line | The example shows `confidence: {}`; the code returns the **full** object `{value, factors[]}`. Do not build a schema from the example. |

#### 1.7.10 The service's own deployment state

`render.yaml`: service name `acs-boq-generator`, **plan: free**, region
`singapore`, `autoDeployTrigger: off`, `healthCheckPath: /health`,
`BOQ_API_STORAGE_MODE=ephemeral`, `BOQ_ALLOW_SAMPLE_DATA=1`,
`BOQ_PRODUCTION_MODE=0`, `BOQ_API_JOB_RETENTION_HOURS=168`,
`BOQ_API_RATE_LIMIT_PER_MINUTE=240`, per-IP limiting **disabled**,
trusted-proxy CIDRs **empty**, and `BOQ_API_FETCH_ALLOWED_HOSTS` set to
`sync: false` — **so it must be filled in manually before the portal can hand
it a file by reference.** The base URL is `https://acs-boq-generator.onrender.com`.

---

## 2. Design decisions — three expert views, reconciled

Three reviews were commissioned: a 30-year software engineer, a 30-year product
manager, and a 30-year PMC quantity surveyor. This section records where they
**agreed**, where they **disagreed**, and what was decided.

### 2.1 Where they agreed

- **The portal must be the system of record.** The service's state is disposable
  and must not be trusted for anything durable. (All three.)
- **The scale must be confirmed by a human, explicitly, and recorded.** (All three.)
- **A SAMPLE/DRAFT banner is not enough on its own; the total must never appear
  without it, and the export must carry the warning too.** (All three.)
- **Corrections need a reason, and the reason must be fast to give.** (All three.)
- **Mobile is a secondary surface.** (PM and QS; the engineer did not disagree.)
- **The work must be a small number of commits with a clear order.** (All three.)

### 2.2 The disagreements, and what was decided

#### D1 — Do we show amounts and a total while the data is SAMPLE?

| View | Position |
|---|---|
| **PM** | No. Reframe v1 as **take-off, not costing**. Hide amounts, subtotals and the total. Hide rate corrections (there is nothing real to correct). Export a quantities-only workbook. |
| **SWE** | Store everything including the total. The export carries the banner. **Hard-block export** when `data_status != REAL`. |
| **QS** | A quantity without a rate is not a BOQ. But an **unpriced, banner-marked take-off** is genuinely useful on its own — provided it is never presented as money. |

**Decision — a middle path that satisfies your stated rule and the PM's warning:**

- The **total is always shown** (your brief: "never show totals *without* it" —
  i.e. totals with the banner are expected), but it is **never a bare headline
  figure**. It appears only inside a walled-off block, labelled
  **"Sample total — placeholder rates, not an estimate"**, in the warning colour,
  immediately under the banner and nowhere else.
- **Amounts** (per-line `rate` and `amount`) are shown but muted, with the
  column header reading **"Amount (sample rate)"**.
- **Rate corrections are hidden** while `data_status != REAL` — there is no real
  rate to correct, and offering the control manufactures false confidence.
  Quantity, reclassify and pick-alternative corrections stay.
- The **export is gated**: the user must tick *"I understand these rates are
  placeholders and this file is not for issue"* before the download starts.
  The acknowledgement, the user and the timestamp are logged.
- **No write path from a generated BOQ into `boq_item` / "BOQ Variance"
  exists or will be built.** Confirmed in the code: `BoqItem` is only created
  by a manual `POST /api/boq`.

> **Open for you (decision 1):** if you would rather follow the PM all the way
> and show **no** money at all until the SOR is real, that is a one-line change
> in the review screen and makes the SAMPLE risk much smaller.

#### D2 — Where does the service client live?

The engineer's review caught a real error in my draft: I had written
`src/lib/boqService.js` for the service client. **`src/` is the Vite frontend**
— a bearer token there is in the public bundle.

**Decision:** `backend/src/lib/boqClient.js`. The token is a Render backend
env var only. The frontend never sees it and never talks to the service
(the service has no CORS and is server-to-server by design).

#### D3 — How does the file get from R2 to the service?

The engineer argued the presigned-GET design was unsafe because "the service
fetches at job start, not at submit", so the URL would expire in the queue, and
recommended streaming the bytes through the portal via the multipart
`POST /jobs`.

**I checked the code. That premise is wrong.** The fetch happens
**synchronously inside the `POST /jobs` request**, before the job row is even
created (`app/api/app.py:916-919` → `await _fetch_source(...)`; the worker then
reads the already-stored local copy). The 10-minute presigned GET is therefore
comfortably safe — the fetch starts within seconds of the POST arriving.

**Decision:** keep **presigned GET references** as the primary mechanism
(`sources[]`), because the service then pulls directly from R2 — one fewer hop,
and no 100 MB streaming through the Render portal backend. Adopt the engineer's
other conclusions:

- The portal's **outbound timeout to the service must be ~180 s**, not the
  30 s default in `src/lib/api.js` — a cold start alone is ~60 s, and the
  service's own fetch has a 60 s total timeout *inside* the POST.
- **Multipart streaming is the documented fallback** if a reference fetch
  times out on a slow link (the service supports it natively).

#### D4 — Where does the snapshot JSON live?

The engineer argued for R2 (a snapshot is 100 KB–2 MB and a 20-row list view
would pull megabytes into the app).

**Decision — split it:** the **`BoqSnapshot` row in Postgres** holds the
scalars (`dataStatus`, `totalsAmount`, `lineCount`, `withheldCount`,
`schemaVersion`, `revision`) and the **R2 blob path**; the **JSON document
itself lives in R2** under `snapshots/` with **no lifecycle expiry**. The row
is still an immutable, append-only model, as you asked; the payload just does
not bloat the list query.

#### D5 — Two tables or three?

The engineer said two (`BoqJob`, `BoqSnapshot`) with corrections read out of
the snapshot's `corrections[]`. The PM wanted a readable audit trail.

**Decision: two.** The service already puts the **whole correction trail** in
the snapshot (`corrections[]`, oldest first, each with `id`, `kind`,
`target_line_id`, `old_value`, `new_value`, `reason`, `requested_by`,
`created_at`) and per-item `original` / `corrected`. The portal renders that
directly. **No `BoqCorrection` table.**

#### D6 — Which settings does the user actually confirm?

The engineer: just the scale. The PM: fewer settings. You: "confirm a few
settings".

**Decision — three, and two of them are optional:**

1. **Drawing scale** — required, per drawing (§2.2 D7).
2. **Rate source** — read from `/meta`'s `sor_sources[]`, defaulting to the
   first available, and **marked `SAMPLE`**. Reordering the priority list is
   out of scope for v1 (a costing decision no employee can make).
3. **Wastage %** — advanced, defaults to the service default (`0.0`).

`location_factor` is **fixed server-side at 1.0** and shown as read-only
("Chennai location factor — not configured yet"), because the CPWD Chennai-zone
cost index is not loaded.

#### D7 — Scale is per job in the service, but drawings differ

The engineer flagged this: `dxf_scale` is **one value per job**. Two DXFs at
1:100 and 1:50 in one job produce silently wrong quantities on one of them.

**Decision:** the portal captures the scale **per drawing** (a row per drawing
with its own scale field). Drawings with the same scale are grouped into one
service job; drawings with a different scale go into a **separate job**. The
user sees one "run" that may produce two BOQs, clearly labelled. The portal
never sends two scales in one request.

#### D8 — Who can reach the page while the data is SAMPLE?

The engineer: a "Tools" group with one item is cosmetic; a nav entry hidden by
a server-side flag is just as much work. The PM: **pilot cohort only** — "broad
discovery is how sample numbers escape".

**Decision — a config switch, not a hard-coded cohort.** A new env var
`BOQ_PILOT_EMPLOYEE_IDS` (comma-separated employee ids):

- **Unset** → open to every employee with an assigned project (matches your
  brief).
- **Set** → only those employees and admins see the nav entry; everyone else
  gets a clear **"This tool is in pilot and is not available to your account"**
  page (not a 404, not a teaser) if they navigate directly.

> **Open for you (decision 2):** I recommend **setting it** while the data is
> SAMPLE, and clearing it when the real SOR lands.

#### D9 — Mobile scope

**Decision:** mobile supports **capture, not authoring**.

| Works on mobile | Desktop only |
|---|---|
| Browse the project's drawings | Full table review |
| Pick / upload a drawing | Reclassify a line |
| Type and confirm the scale | Pick an alternative rate source |
| See job status | Rate overrides |
| Read flagged lines | Multi-drawing scale matrix |
| Apply a **quantity** override with a reason | Export |

The waiting screen says *"This usually takes a few minutes — you can close this
page."* and the job keeps running server-side.

**The QS's mobile wish-list is v2, not v1.** They asked for saved BOQs to open
offline (no signal on site), a downloadable PDF, and "capture a discrepancy
against a line, with a photo, the actual measured quantity and a note, that
queues and syncs to the office as a pending correction". None of that is a
v1 requirement and two of them (offline reads, queued sync) need a service
worker and a sync protocol — a different piece of work. **v1 mobile = read,
review and correct**, which is what the QS's own sentence allows
(*"I will not upload DXF, take off or price anything on a phone"*).

One v1 adjustment follows from that: **new uploads on mobile are disabled
above 5 MB** with the note *"Upload drawings from a computer — this file is
too large for a phone connection."* Existing drawings can still be selected
and run on a phone.

#### D10 — "Confirm the scale" is a false comfort; the QS wants a calibration

The QS's verdict was blunt: *"1:100 is a plotting scale printed in the title
block; it does not calibrate the file."* If the CAD was drawn in real
millimetres and plotted at 1:100, the model is already correct and entering
`100` divides or multiplies everything by 100; if the drafter drew at 1:100
and plotted 1:1, the model is 1/100 of real. **I checked the code — the QS is
right about the arithmetic and right about the risk.** The service computes:

```python
# app/extractors/dxf.py:191
units_per_m = INSUNITS_TO_METRES[insunits] * scale
```

The scale **multiplies** the drawing unit. The unit comes from the file's
`$INSUNITS` (or the layer map); the scale is the only thing the user supplies.
A DXF job with no confirmed scale is **failed outright** by the worker
(`SOURCE_UNCALIBRATED`, `app/api/worker.py:286-300`).

**What the service cannot do (and therefore what v1 cannot promise):**

| The QS asked for | Is it possible today? |
|---|---|
| Per-**file** unit declaration | **No.** The unit is read from `$INSUNITS` by the service; the API accepts no unit parameter. |
| Per-**file** scale | **No.** `dxf_scale` is one float per job. (v1 works around this by splitting jobs — D7.) |
| Echo the calibration back ("one unit = X mm") | **No.** The snapshot's `scale` block is `{value, denominator, confirmed_by, suggested, source}` — no unit, no calibration note. |
| Verify a known dimension automatically | **No.** Neither the service nor the portal can measure the drawing; there is no DXF parser in the portal. |

**Decision — v1 ships the service's model, but stops pretending it is more
than it is:**

1. The screen is called **"Drawing calibration"**, not "Scale", and always
   shows the arithmetic: *"The service reads the drawing unit from the file
   and multiplies it by the number you enter."*
2. The **1:1-in-real-millimetres warning is permanent**, not a tooltip.
3. The **known-dimension check** is an optional field, **recorded** on the job,
   printed on the review screen and in the export — and explicitly labelled
   *"v1 records this; it does not check it for you."*
4. The **QS's full calibration** (per-file unit + measured dimension + an echo
   the portal can verify) is listed as **open question 1 for the service
   owner** (§11). It is a service change, not a portal change.

> **Open for you (decision 3):** if the drawings that will actually be used
> are drawn in real millimetres (the common case for exported BIM/IFC-derived
> DXF), the safe default is **1** — and the portal should offer a
> **"the file is already in real millimetres"** preset that fills `1` and
> records *who* chose it. That is a one-field change if you want it.

#### D11 — What is this thing called while the rates are sample?

| View | Position |
|---|---|
| **PM** | Reframe as **take-off, not costing**. |
| **QS** | Harder: *"until then it is a fast first draft I rebuild in Excel"* and *"never let it say BOQ"* — because "BOQ" is a priced document and this is not one. |
| **SWE** | Keep the name; gate the export. |

**Decision — keep the name, change the label under it.** The nav item is
**"BOQ Generator"** (your brief). The page heading and the page subtitle are
**status-driven**:

| `effectiveStatus` | Page title | Subtitle |
|---|---|---|
| `SAMPLE` | **Quantity take-off — sample rates** | "Not a priced BOQ. Do not issue." |
| `DRAFT` | **Quantity take-off — draft rates** | "Rates are a draft. Do not issue." |
| `REAL` | **BOQ** | "Priced from {source}, {edition}." |

The **export filename carries it too** (`SAMPLE_ACS-BOQ_Project_Rev0_2026-10-26.xlsx`)
and the workbook's first sheet has the banner in the header and the footer.

#### D12 — "This is not the project cost" and the coverage statement

The QS will not trust a total that does not say what is missing, and named the
specific abandonment trigger: *"a total reaching the client because nothing
said what was excluded."*

**Decision — a permanent "What this number covers" card** on the review screen
and the first sheet of the export, containing:

| Line | Source |
|---|---|
| "Total of priced items only — **not the project cost**." | fixed copy |
| "X of Y lines priced (Z% unpriced)" | `totals.withheld_count`, `totals.line_count` |
| "Kept out of the total: {reason → count}" | `withheld_by_reason` (from `/boq`) |
| "Files measured: {n}" / "Files received but not measured: {n}" | `inputs[]` vs `lines[]` provenance |
| "Not included: site works, earthwork, doors and windows, finishes, preliminaries, escalation, GST, contingency." | fixed list — **the service cannot know these are missing**, because they are missing from the *model*, not from the drawing |
| "Additional exclusions (your note): {free text}" | user-entered, stored on the job, printed in the export |
| "Calibration: {scale}, confirmed by {who} on {when}. {known-dimension note}" | portal job row |

The last two are **portal-owned**, not service data — the service has no
concept of exclusions. This is the one place where the portal adds meaning the
service cannot.

#### D13 — The reason for a correction is a dropdown, not an essay

The QS: *"Reason as a dropdown, not an essay … Mandatory, but five seconds."*

**Decision:** the correction drawer offers **six fixed reasons** plus an
optional one-line note, and composes the service's free-text `reason` field as
`"{dropdown reason} — {note}"`:

1. Checked against the drawing
2. Measured on site
3. As per site instruction
4. As per client email (date)
5. Rate basis changed
6. Duplicate — removed

The service requires a non-empty `reason` on every correction
(`app/api/schemas.py`), so the portal can never send one without a reason.

#### D14 — Items that exist on site but are not in the model

The QS wants an **"insert item"** action (doors, sanitary, painting, which
the model may not contain) and an "add missing item" control.

**Decision: not in v1.** The service's `PATCH /jobs/{id}/lines/{line_id}`
accepts only `qty`, `rate`, `item_code`, `alternative_code` and
`alternative_source` on **existing** lines — there is no line-creation
endpoint, so an inserted item would have to be a *manual* line the portal
invented and the service never saw. That is a portal-side BOQ editor, which is
a different product. **Listed as open question 2** (§11): if the estimate
workflow needs it, the honest v1 answer is *"take-off of what is in the model"*
with the exclusions card above saying so.

#### D15 — The QS's "five changes I demand", and where each landed

| # | The QS's demand | Landed? |
|---|---|---|
| 1 | Per-file calibration with a measured dimension | **Partly.** v1 keeps the service's one-scale-per-job model, adds the permanent multiplier warning and records an unverified known-dimension note (§2.2 D10). The rest needs a service change. |
| 2 | Coverage and exclusions on the summary and every export | **Yes** — §2.2 D12. |
| 3 | Real rates with a stamped SOR edition, or it is not a BOQ | **Yes for the label** (§2.2 D11). The real rates are a data task, not a code task — the portal reads `sor_sources[]` from `/meta` and stamps the edition if one exists. |
| 4 | PDF, DWG, own template, manual item insertion | **No** — PDF and DWG are service limits; template and insertion are a v2 product (§11). |
| 5 | Revision history, change log, derived lines for shuttering / reinforcement / plaster / flooring / painting | **Partly.** Change log and audit trail: yes (the snapshot's `corrections[]`). Derived lines: the service already produces `materials[]` and `derivations[]`; the portal renders them in a **"Derived quantities"** panel (§3.6) instead of inventing them. |

### 2.3 Where the engineer's review was factually wrong

Recorded so the reasoning is auditable:

1. **"The service fetches at job start, not at submit."** Wrong — see D3.
   `app/api/app.py:916-919` fetches inside the POST.
2. **"Do not build a fake BOQ service inside the portal codebase."** Your brief
   explicitly asks for one. Built, but with a live contract-test path against
   the real service so drift is caught (§9.2).
3. **"Reuse `dpr-documents` instead of a new bucket."** Your brief requires a
   separate bucket, and `dpr-documents` is capped at 25 MB against a 100 MB
   service limit. The separate bucket also lets the BOQ token be scoped to one
   bucket.

### 2.4 Design principles carried into the build

1. **Plain language over codes.** Every reason code has a sentence a QS can
   act on; the machine code stays in a tooltip for audit.
2. **The service is a calculator, not a source of truth.** The portal stores
   everything durable.
3. **The barrier is the export gate, not the colour.** Blocking issues are
   visible and countable; the download is what asks for acknowledgement.
4. **One thing per screen.** The guided flow is: choose → confirm → wait →
   review → save.
5. **Nothing is silently re-done.** A correction never re-runs the pipeline;
   a changed scale means a **new job**, and the old snapshot is retained.

---

## 3. Page layout — wireframes

### 3.1 Conventions used in every state

- **Banner colours:** the SAMPLE banner is a full-width amber block
  (`#B45309` on `#FEF3C7`-ish) with a **"⚠ SAMPLE DATA"** badge on the left and
  the plain-language sentence on the right. It is **sticky** at the top of the
  page on every screen where a BOQ or a total exists, and it also appears
  inline above the totals block. It is never dismissible.
- **The same three sentences everywhere** (§3.5).
- **Toasts** are for transient confirmations only ("Saved", "Correction
  applied"). They never carry a warning that matters — those go in a banner.
- Desktop breakpoint 768 px, matching the portal's existing
  `.portal-*` CSS convention. Below 768 the page is a stack of cards.

### 3.2 Desktop — the six screens

#### (a) Empty state — no project chosen

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ☰  ACS Chennai Portal                                    Adithya ▾             │
├───────────────┬──────────────────────────────────────────────────────────────┤
│ My Work       │  Tools                                                          │
│  My Attendance│  ┌────────────────────────────────────────────────────────┐  │
│  My Leave     │  │  BOQ Generator                                        │  │
│  ...          │  │  Turn a drawing set into a Bill of Quantities you can  │  │
│ My Reports    │  │  check line by line, then save it.                     │  │
│  ...          │  │                                                        │  │
│ Tools         │  │  ┌────────────────────────────────────────────────┐    │  │
│  ▣ BOQ Generator│ │  │ 1  Choose a project                         │    │  │
│               │  │  │   ┌──────────────────────────────────────┐   │    │  │
│ (admin…)      │  │  │   │  Search or pick a project…         ▾  │   │    │  │
│               │  │  │   └──────────────────────────────────────┘   │    │  │
│               │  │  │   You have 3 assigned projects.              │    │  │
│               │  │  └────────────────────────────────────────────────┘    │  │
│               │  │  ┌────────────────────────────────────────────────┐    │  │
│               │  │  │  ⓘ  This tool is still running on sample data. │    │  │
│               │  │  │     See the notice at the top of every BOQ.  │    │  │
│               │  │  └────────────────────────────────────────────────┘    │  │
│               │  └────────────────────────────────────────────────────────┘  │
└───────────────┴──────────────────────────────────────────────────────────────┘
```

Empty-state copy:
> **BOQ Generator**
> Turn a drawing set into a Bill of Quantities you can check line by line, then save it.
> **1 Choose a project** — pick one of the projects you are assigned to.

#### (b) Choosing drawings

```
│  ┌─ BOQ Generator ─────────────────────────────────────────── Step 1 of 3 ─┐  │
│  │                                                                       │  │
│  │  1 Choose drawings      2 Confirm settings      3 Review & save        │  │
│  │  ●━━━━━━━━━━━━         ○──────────────         ○──────────────        │  │
│  │                                                                       │  │
│  │  Project:  【 Prestige Tower — Block A  ▾】                          │  │
│  │                                                                       │  │
│  │  FROM THIS PROJECT                                                   │  │
│  │  ┌────────────────────────────────────────────────────────────────┐  │  │
│  │  │ ☐  BlockA_Ground_Plan.dxf        DXF · 4.2 MB · uploaded 2 Oct  │  │  │
│  │  │ ☑  BlockA_Section_AA.dxf         DXF · 1.8 MB · uploaded 2 Oct  │  │  │
│  │  │ ☐  BlockA_Layout.pdf             PDF · 12.4 MB                 │  │  │
│  │  │      ⓘ PDF drawings cannot be measured yet — the service only  │  │  │
│  │  │        reads IFC and DXF. It is listed so you know it is there. │  │  │
│  │  └────────────────────────────────────────────────────────────────┘  │  │
│  │  [Show all 7 attachments]                                            │  │
│  │                                                                       │  │
│  │  UPLOAD NEW DRAWINGS                                                │  │
│  │  ┌────────────────────────────────────────────────────────────────┐  │  │
│  │  │   Drag DXF or IFC files here, or  [ Choose files ]             │  │  │
│  │  │   IFC and DXF only · up to 100 MB each · up to 20 files         │  │  │
│  │  │   DWG? Convert it to DXF first (ODA File Converter / LibreDWG) │  │  │
│  │  └────────────────────────────────────────────────────────────────┘  │  │
│  │                                                                       │  │
│  │                                       [ Back ]   [ Continue → ]     │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
```

#### (c) Uploading

```
│  │  UPLOADING                                                                │  │
│  │  ┌──────────────────────────────────────────────────────────────────┐    │  │
│  │  │  ⠙  Uploading  BlockA_Ground_Plan.dxf                    62 %    │    │  │
│  │  │     ████████████████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░    │    │  │
│  │  │     2.6 MB of 4.2 MB                                            │    │  │
│  │  └──────────────────────────────────────────────────────────────────┘    │  │
│  │  ┌──────────────────────────────────────────────────────────────────┐    │  │
│  │  │  ✓  BlockA_Section_AA.dxf          Uploaded                       │    │  │
│  │  └──────────────────────────────────────────────────────────────────┘    │  │
│  │  (uploads run one at a time — a phone on site may be slow)               │  │
```

Upload failure (inline, per file, never a toast):
> **Could not upload `BlockA_Site_Plan.dxf`** — the file is 118 MB, over the
> 100 MB limit. Split it or compress it and try again.

#### (d) Settings — including scale confirmation

```
│  │  1 Choose drawings   2 Confirm settings   3 Review & save                │  │
│  │  ●━━━━━━━━━━━━━━     ●━━━━━━━━━━━━        ○──────────────                │  │
│  │                                                                          │  │
│  │  ⚠ SAMPLE DATA — NOT AN ESTIMATE                                          │  │
│  │  Quantities are measured from your drawings. The rates are placeholders  │  │
│  │  because ACS Chennai's Schedule of Rates has not been loaded yet.        │  │
│  │  This BOQ must not be issued to a client.                                │  │
│  │                                                                          │  │
│  │  CHECK THE DRAWING CALIBRATION BEFORE MEASUREMENT                       │  │
│  │  A DXF file does not carry its plotting scale — it is printed in the     │  │
│  │  title block. Every quantity below is measured at the scale you confirm. │  │
│  │                                                                          │  │
│  │  ┌────────────────────────────────────────────────────────────────────┐  │  │
│  │  │ Drawing                     Scale on drawing   Confirm (1:___)   │  │  │
│  │  │ ────────────────────────────────────────────────────────────────── │  │  │
│  │  │ BlockA_Ground_Plan.dxf       1 : ___            [ ___ ]  [1:100]│  │  │
│  │  │ BlockA_Section_AA.dxf        1 : ___            [ ___ ]  [1:100]│  │  │
│  │  └────────────────────────────────────────────────────────────────────┘  │  │
│  │  Enter the denominator only: 100 for a 1:100 drawing.                   │  │
│  │  ℹ Our drawing-library suggestion is not used for your drawings — read   │  │
│  │    the title block.                                                       │  │
│  │  ⓘ BlockA_Ground_Plan.dxf and BlockA_Section_AA.dxf are at different    │  │
│  │    scales. They will be measured as two separate BOQs.                  │  │
│  │  ⚠ Read this once — it decides every number in the BOQ.                │  │
│  │    The service reads the drawing unit from the file and MULTIPLIES it   │  │
│  │    by the number you enter: 1 drawing mm × 100 = 100 mm real.           │  │
│  │    If the DXF was drawn in real millimetres (title block says 1:100    │  │
│  │    but the file itself is already 1:1), enter 1 — not 100.              │  │
│  │    A wrong number here scales every quantity by the same factor.        │  │
│  │  │  Known-dimension check (optional, recorded on the BOQ):              │  │
│  │  │  [ e.g. grid spacing 6.0 m measured against the plan ]              │  │
│  │  │  ⚠ v1 records this note; it does not check it for you.              │  │
│  │                                                                          │  │
│  │  RATE SOURCE                                                            │  │
│  │  ┌────────────────────────────────────────────────────────────────────┐  │  │
│  │  │ ○ TN_PWD_SOR  (sample rates)                                       │  │  │
│  │  │ ○ CPWD_DSR    (sample rates)                                       │  │  │
│  │  │   Only 1 rate loaded · no edition recorded · no region recorded    │  │  │
│  │  └────────────────────────────────────────────────────────────────────┘  │  │
│  │                                                                          │  │
│  │  ▸ Advanced                                                             │  │
│  │    Wastage on materials:  0 %          (rates are already gross of waste) │  │
│  │    Location factor:       1.00  (read-only — Chennai index not loaded)   │  │
│  │                                                                          │  │
│  │                                       [ Back ]   [ Generate BOQ → ]     │  │
│  └──────────────────────────────────────────────────────────────────────────┘  │
```

**Rules on this screen**
- The scale field is **required** whenever a DXF is selected. The "Generate"
  button stays disabled and says *"Confirm the drawing scale to continue"*.
- The scale is a **denominator** (`100` = 1:100) with a `1:` prefix in the UI.
- The service's `scale_suggestion` is **not shown as a suggestion**, because in
  the current deployment it is `1`, taken from a synthetic sample layer map
  that explicitly disclaims any relation to ACS drawings (§1.7.7). If a real
  ACS layer map is ever supplied, this becomes a "suggested, unverified" hint.
- The scale is recorded with **who confirmed it and when**, and it is stored on
  the portal's job row *and* sent as the service's `requested_by` so it lands
  in the service's audit trail.
- **The multiplier warning is always shown, not only on hover.** The service
  computes `units_per_m = drawing_unit_in_metres × scale` — the scale
  **multiplies** (`app/extractors/dxf.py:191`). This is the single most
  dangerous number in the whole flow, because a 100× error produces a BOQ that
  looks completely ordinary (§2.2 D10).
- **The known-dimension note is optional but recorded.** It is stored on the
  portal's job row, printed on the review screen under "What this number
  covers", and written into the export. **v1 does not verify it** — the portal
  has no DXF parser and the service exposes no calibration-echo endpoint
  (§11, open question 3).

#### (e) Waiting — including the service waking up

```
│  │  1 Choose drawings   2 Confirm settings   3 Review & save                │  │
│  │  ●━━━━━━━━━━━━━━     ●━━━━━━━━━━━━━━━      ◐──────────────               │  │
│  │                                                                          │  │
│  │                 ⟳                                                        │  │
│  │          Measuring your drawings                                         │  │
│  │                                                                          │  │
│  │  ┌────────────────────────────────────────────────────────────────────┐  │  │
│  │  │  Status        Starting up the drawing service                    │  │  │
│  │  │  Elapsed       0:12                                                   │  │  │
│  │  │  Files         BlockA_Ground_Plan.dxf, BlockA_Section_AA.dxf        │  │  │
│  │  └────────────────────────────────────────────────────────────────────┘  │  │
│  │                                                                          │  │
│  │  ⏳ The drawing service is waking up. This can take a minute the first   │  │
│  │     time you use it after a break.                                      │  │
│  │                                                                          │  │
│  │  You can close this page — the job will keep running, and the BOQ will  │  │
│  │  be waiting when you come back.                                         │  │
│  │                                                                          │  │
│  │  ℹ The drawing service forgets unfinished jobs if it restarts. If that   │  │
│  │    happens we will tell you and you can run it again.                   │  │
│  └──────────────────────────────────────────────────────────────────────────┘  │
```

States on this screen, driven by `status`:
`queued` → "Queued — another job is being measured first."
`running` → "Measuring your drawings."
`done` → advance to review.
`failed` → see (h).
Cold start (first request after 15 min idle) → the "waking up" copy above for
the first ~60 s.

#### (f) Review — grouped BOQ, flagged lines first

```
│  │  ⚠ SAMPLE DATA — NOT AN ESTIMATE                                          │  │
│  │  Quantities are measured from your drawings. The rates are placeholders.  │  │
│  │  Do not issue this BOQ.                                                  │  │
│  │                                                                          │  │
│  │  ┌────────────────────────────────────────────────────────────────────┐  │  │
│  │  │ ⚠ 23 of 340 lines need your review   ·   12 lines are not priced  │  │  │
│  │  │ [ Show only lines needing review ]      [ Acknowledge and export ]│  │  │
│  │  └────────────────────────────────────────────────────────────────────┘  │  │
│  │                                                                          │  │
│  │  ⌄ NEEDS YOUR REVIEW (23)                                              │  │
│  │  ┌────────────────────────────────────────────────────────────────────┐  │  │
│  │  │ ⛔ Not matched to any rate source                                  │  │  │
│  │  │ ────────────────────────────────────────────────────────────────── │  │  │
│  │  │ Level        Item      Description          Unit  Qty    Amount  │  │  │
│  │  │ Ground Floor RCC-01   Reinforced concrete…  cum   12.35  ⚠        │  │  │
│  │  │ Level        Item      Description          Unit  Qty    Amount  │  │  │
│  │  │ Ground Floor RCC-09   Coping (not in WBS)   cum    1.20  —        │  │  │
│  │  │ ────────────────────────────────────────────────────────────────── │  │  │
│  │  │ ⚠ Size was not readable from the drawing, so a default was used.   │  │  │
│  │  │   Check the quantity.                              [ Review line ] │  │  │
│  │  └────────────────────────────────────────────────────────────────────┘  │  │
│  │  ▸ ⌄ RCC — Reinforced concrete (48)                                      │  │
│  │  ▸ ⌄ Structural steel (22)                                               │  │
│  │  ▸ ⌄ Plaster & finishes (119)                                           │  │
│  │  ▸ ⌄ Not priced — left out of the total (12)                            │  │
│  │                                                                          │  │
│  │  ┌────────────────────────────────────────────────────────────────────┐  │  │
│  │  │ SAMPLE TOTAL — placeholder rates, not an estimate      ₹ 12,43,210│  │  │
│  │  │ 340 lines · 12 lines not priced · rates from TN_PWD_SOR (sample)  │  │  │
│  │  └────────────────────────────────────────────────────────────────────┘  │  │
│  │                                                                          │  │
│  │  [ Audit trail (3 corrections) ]        [ Save & download Excel ]       │  │
│  └──────────────────────────────────────────────────────────────────────────┘  │
```

**Layout rules**
- The screen is **three bands, in this order**, not tabs: (1) *Needs your
  review*, (2) *the rest of the groups*, (3) *Not priced — left out of the
  total*. The first band is expanded; the rest are collapsed groups with
  "n of m lines need review" counts on the chip.
- **Severity is colour + icon + words.** Never colour alone.
  - ⛔ red — blocking: the line is not priced, or its unit does not match the rate.
  - ⚠ amber — needs checking: a default was used, a fallback was taken.
  - ℹ blue — informational: this is how it was measured.
- The **machine code** stays in a tooltip on the badge (`SOURCE_UNCALIBRATED`),
  for audit.
- The **total block is always the last thing on the screen**, always inside the
  warning treatment, never a headline.
- `withheld_by_reason` from the service drives the "n lines not priced" chip.

#### (g) Line detail and correction (drawer, desktop)

```
│                                                     ┌──────────────────────────────┐
│  ... review table ...                               │  RCC-01 · Reinforced concrete │
│                                                     │  Ground Floor                │
│                                                     │                              │
│                                                     │  Quantity      12.346 cum    │
│                                                     │  Rate          ⚠ sample      │
│                                                     │  Amount        ⚠ sample      │
│                                                     │                              │
│                                                     │  HOW THIS WAS MEASURED       │
│                                                     │  ✓ Measured from the drawing  │
│                                                     │    geometry                  │
│                                                     │  ⚠ Size was not readable, so  │
│                                                     │    a default was used         │
│                                                     │                              │
│                                                     │  MATCHED TO                   │
│                                                     │  ✗ No rate found for this item│
│                                                     │  Candidates:                  │
│                                                     │   · RCC-01 Exact match        │
│                                                     │   · RCC-02 Similar desc.      │
│                                                     │   · RCC-14 Similar desc.      │
│                                                     │                              │
│                                                     │  PROVENANCE                   │
│                                                     │  File   BlockA_Ground_Plan.dxf│
│                                                     │  Layer  A-WALL                │
│                                                     │  Scale  1:100 (confirmed by   │
│                                                     │         you on 26 Oct)        │
│                                                     │                              │
│                                                     │  WHAT DO YOU WANT TO CHANGE?  │
│                                                     │  ( ) Quantity                 │
│                                                     │  ( ) Wrong item               │
│                                                     │  ( ) Move to another group    │
│                                                     │  ( ) Use a different rate     │
│                                                     │      (hidden while sample)    │
│                                                     │                              │
│                                                     │  New quantity  [ 12.50 ]     │
│                                                     │  Reason *                     │
│                                                     │  [ Measured on site on 26 Oct ]│
│                                                     │  [ Scale was wrong ]          │
│                                                     │  [ Overlaps line RCC-04 ]    │
│                                                     │  [ Duplicate ]                │
│                                                     │  [ Includes openings ]        │
│                                                     │  [ Other (describe)      ]    │
│                                                     │                              │
│                                                     │  ⓘ A reason is required. It  │
│                                                     │    is shown in the audit      │
│                                                     │    trail with your name.      │
│                                                     │                              │
│                                                     │  [ Cancel ]  [ Apply change ] │
│                                                     └──────────────────────────────┘
```

- **The reason is a set of one-tap quick reasons first**, free text second
  (minimum 4 characters). Fast, but never a free-text-only box.
- The quick reasons are the ones a QS actually says: *Measured on site*,
  *Scale was wrong*, *Overlaps line X*, *Duplicate*, *Includes openings*,
  *Other*.
- **A correction with an empty reason is refused client-side and server-side.**
  The service also requires `reason` and `requested_by`; the portal refuses
  earlier with a clearer message.
- **Changing the scale is not a correction** — it is a new job. The drawer
  says *"If the scale was wrong, start a new run with the right scale."*

#### (h) Audit trail

```
│  │  ┌── Audit trail ──────────────────────────────────────────────────────┐  │  │
│  │  │ Generated  26 Oct 2026, 14:22  by Adithya M                          │  │  │
│  │  │ Inputs     BlockA_Ground_Plan.dxf (sha256 3f2a…c901, 4.2 MB)       │  │  │
│  │  │            BlockA_Section_AA.dxf  (sha256 9b71…4e2f, 1.8 MB)        │  │  │
│  │  │ Scale      1:100 confirmed by Adithya M on 26 Oct 2026, 14:20      │  │  │
│  │  │ Reader     ezdxf 1.x  ·  data status SAMPLE                        │  │  │
│  │  │                                                                     │  │  │
│  │  │ Corrections                                                      │  │  │
│  │  │  26 Oct 14:31  Quantity  RCC-01  Ground Floor                     │  │  │
│  │  │                12.346 → 12.50   "Measured on site on 26 Oct"      │  │  │
│  │  │                by Adithya M                                       │  │  │
│  │  │  26 Oct 14:34  Item     RCC-09  Ground Floor                     │  │  │
│  │  │                RCC-09 → RCC-11   "Wrong item — coping is RCC-11"  │  │  │
│  │  │                by Adithya M                                       │  │  │
│  │  └─────────────────────────────────────────────────────────────────────┘  │  │
```

The trail is read straight out of the snapshot's `corrections[]` — oldest first,
with `kind`, `target_line_id`, `old_value`, `new_value`, `reason`,
`requested_by`, `created_at`.

#### (i) Saved

```
│  │  ┌────────────────────────────────────────────────────────────────────┐  │  │
│  │  │  ✓  BOQ saved                                                      │  │  │
│  │  │                                                                    │  │  │
│  │  │  BlockA_Ground_Plan.dxf · 340 lines · 23 still need review        │  │  │
│  │  │  Saved 26 Oct 2026, 14:40  ·  stored as revision 2                 │  │  │
│  │  │                                                                    │  │  │
│  │  │  ⚠ SAMPLE DATA — NOT AN ESTIMATE                                  │  │  │
│  │  │  This file has placeholder rates and must not be issued.           │  │  │
│  │  │                                                                    │  │  │
│  │  │  ☑ I understand these rates are placeholders and this file is not  │  │  │
│  │  │    for issue.                                                      │  │  │
│  │  │                                                                    │  │  │
│  │  │  [ Download Excel (BOQ, materials, flags) ]                       │  │  │
│  │  │                                                                    │  │  │
│  │  │  [ Review again ]  [ Start a new run ]                            │  │  │
│  │  └────────────────────────────────────────────────────────────────────┘  │  │
```

### 3.3 Mobile — the same states

Mobile is one column. The sidebar is a drawer; the bottom tab bar is unchanged
(the BOQ Generator is **not** added to it).

```
(a) EMPTY                          (b) CHOOSING DRAWINGS
┌──────────────────────┐          ┌──────────────────────┐
│ ☰  BOQ Generator  ⋮ │          │ ←  Choose drawings    │
├──────────────────────┤          ├──────────────────────┤
│                      │          │ Step 1 of 3           │
│  Turn a drawing set  │          │                      │
│  into a BOQ you can  │          │ Project              │
│  check, then save.   │          │ [ Prestige Tower ▾ ] │
│                      │          │                      │
│  1 Choose a project  │          │ FROM THIS PROJECT    │
│  [ Search project ▾ ]│          │ ┌──────────────────┐ │
│                      │          │ │☑ Ground_Plan.dxf│ │
│  ℹ Sample data — see │          │ │  DXF · 4.2 MB    │ │
│    the notice on     │          │ ├──────────────────┤ │
│    every BOQ.        │          │ │☐ Layout.pdf      │ │
│                      │          │ │  PDF — cannot be │ │
│  [ Start → ]         │          │ │  measured yet    │ │
│                      │          │ └──────────────────┘ │
│                      │          │                      │
│                      │          │ UPLOAD NEW           │
│                      │          │ [ + Choose files ]   │
│                      │          │ IFC/DXF · ≤100 MB    │
│                      │          │                      │
│                      │          │ [ Continue → ]       │
└──────────────────────┘          └──────────────────────┘

(c) UPLOADING                   (d) SETTINGS / SCALE
┌──────────────────────┐          ┌──────────────────────┐
│ ←  Uploading       ⋮ │          │ ←  Confirm settings  │
├──────────────────────┤          ├──────────────────────┤
│ ⠙ Ground_Plan.dxf    │          │ Step 2 of 3           │
│ ████████░░░░░░  62 % │          │                      │
│ 2.6 MB of 4.2 MB     │          │ ⚠ SAMPLE DATA —      │
│                      │          │   NOT AN ESTIMATE     │
│ ✓ Section_AA.dxf     │          │                      │
│                      │          │ CHECK THE SCALE      │
│                      │          │ Your DXF has no scale │
│                      │          │ — read the title     │
│                      │          │ block.                │
│                      │          │                      │
│                      │          │ Ground_Plan.dxf       │
│                      │          │ 1: [___] [1:100]     │
│                      │          │ Section_AA.dxf        │
│                      │          │ 1: [___] [1:100]     │
│                      │          │                      │
│                      │          │ [ Generate BOQ → ]   │
└──────────────────────┘          └──────────────────────┘

(e) WAITING                       (f) REVIEW
┌──────────────────────┐          ┌──────────────────────┐
│ ←  Measuring      ⋮  │          │ ←  Review          ⋮  │
├──────────────────────┤          ├──────────────────────┤
│                      │          │ ⚠ SAMPLE DATA —      │
│        ⟳             │          │   NOT AN ESTIMATE     │
│  Measuring your      │          │                      │
│  drawings            │          │ ⚠ 23 of 340 lines    │
│                      │          │   need your review   │
│  Status  Starting up │          │ [ Show only flagged ]│
│  Elapsed 0:12        │          │                      │
│                      │          │ ⛔ NOT MATCHED (14)   │
│  ⏳ The drawing       │          │ ┌──────────────────┐ │
│  service is waking   │          │ │RCC-01 Ground Fl. │ │
│  up. Up to a minute. │          │ │12.346 cum  ⚠     │ │
│                      │          │ │[ Review line ]    │ │
│  You can close this  │          │ └──────────────────┘ │
│  page.               │          │                      │
│                      │          │ ⚠ DEFAULTED SIZE (5) │
│                      │          │ ┌──────────────────┐ │
│                      │          │ │RCC-01 Ground Fl. │ │
│                      │          │ │1.20 cum   ⚠      │ │
│                      │          │ │[ Review line ]    │ │
│                      │          │ └──────────────────┘ │
│                      │          │                      │
│                      │          │ ▸ RCC (48)           │
│                      │          │ ▸ Steel (22)         │
│                      │          │ ▸ Not priced (12)    │
│                      │          │                      │
│                      │          │ ┌──────────────────┐ │
│                      │          │ │SAMPLE TOTAL       │ │
│                      │          │ │₹12,43,210         │ │
│                      │          │ │placeholder rates  │ │
│                      │          │ └──────────────────┘ │
│                      │          │                      │
│                      │          │ [ Audit trail ]       │
│                      │          │ [ Save & download ]   │
└──────────────────────┘          └──────────────────────┘

(g) CORRECTION (full-screen sheet)   (h) SAVED
┌──────────────────────┐          ┌──────────────────────┐
│ ✕  RCC-01            │          │ ←  Saved           ⋮ │
├──────────────────────┤          ├──────────────────────┤
│ Ground Floor         │          │ ✓ BOQ saved          │
│                      │          │                      │
│ Qty 12.346 cum       │          │ ⚠ SAMPLE DATA —      │
│ ⚠ Not matched to any │          │   NOT AN ESTIMATE     │
│   rate source        │          │                      │
│                      │          │ ☑ I understand these  │
│ Change:              │          │   rates are          │
│ (•) Quantity         │          │   placeholders and    │
│ ( ) Wrong item       │          │   this is not for     │
│ ( ) Move group       │          │   issue.             │
│                      │          │                      │
│ New qty [ 12.50 ]    │          │ [ Download Excel ]   │
│                      │          │                      │
│ Reason *             │          │ [ Review again ]     │
│ [Measured on site ]  │          │ [ New run ]          │
│ [Scale was wrong ]   │          │                      │
│ [Other          ]    │          │                      │
│                      │          │                      │
│ [ Apply change ]     │          │                      │
└──────────────────────┘          └──────────────────────┘
```

### 3.4 Plain-language copy for the reason codes

The machine code stays in a tooltip for audit; the sentence is what the user
reads. **Blocking** = the line is not priced or is unsafe to trust. **Check**
= a default or fallback was used. **Info** = how it was measured.

**Vocabulary — the service's words and the portal's words.** The machine terms
never reach the screen; the right-hand column is what the estimator sees. This
mapping came from the quantity-surveyer review.

| Service term | What the user reads |
|---|---|
| `level` | **Storey / floor** |
| `group` / `group_name` (WBS) | **Bill group** (the heading a trade is rolled up under) |
| `item_code` | **SOR item no.** |
| `description` | **Description** (as printed in the rate book) |
| `rate_source` | **Rate book** |
| `match_tier` | **Rate match — how sure are we** |
| `reason_codes` / `flags` | **Check points** |
| `withheld` | **Kept out of the total** |
| `qty` / `unit` | **Quantity / Unit** |
| `base_rate` | **Base rate** |
| `confidence` | **How sure** |
| `derivations[]` | **Derived quantities** (calculated from other lines) |
| `materials[]` | **Material totals** |
| `reclassify` | **Correct the item** |
| `bounding box` / `polyline` / `entity` / `layer map` / `heuristic` | **outer box** / **outline** / **object** / **our layer list** / **decided by name only** |
| `coefficient` | **material per unit** |

| Machine code | What the user reads | Tier |
|---|---|---|
| `SOURCE_UNCALIBRATED` | The drawing was not calibrated, so nothing could be measured from it. Confirm the scale and run it again. | ⛔ Blocking |
| `UNIT_UNRECOGNISED` | The unit on this drawing is not one we recognise, so the quantity cannot be priced. | ⛔ Blocking |
| `NO_CANDIDATE_IN_ANY_SOURCE` | No rate for this item in any schedule. The amount is kept out of the total — enter a rate if you have one. | ⛔ Blocking |
| `PRIORITY_EXHAUSTED` | No rate found in the rate sources you chose. It is kept out of the total. | ⛔ Blocking |
| `SAMPLE_RATE_BLOCKED` | The rate for this item is placeholder data. | ⛔ Blocking |
| `UNIT_MISMATCH` | The rate is for a different unit than the quantity (for example a rate per m3 against a quantity in m2), so it was not priced. | ⛔ Blocking |
| `WBS_UNMAPPED` | This item is not under any bill group yet, so it is kept out of the total. Which group does it belong to? | ⛔ Blocking |
| `SOR_CHAPTER_RESTRICTED` | The rate source does not cover this type of work. | ⚠ Check |
| `AMBIGUOUS_MULTIPLE_MATCH` | More than one rate item matches this description. Please pick the item number. | ⚠ Check |
| `DESCRIPTION_MATCH_LOW` | The rate was matched loosely from the description. Please check it. | ⚠ Check |
| `DIMENSIONS_DEFAULTED` | The size was not in the model, so an assumed size was used. Please confirm the size. | ⚠ Check |
| `BBOX_FALLBACK` | Measured from the outer box, so voids are included — this over-estimates. Please check the quantity. | ⚠ Check |
| `NON_SOLID_GEOMETRY` | This object is not a solid shape, so the quantity is approximate. | ⚠ Check |
| `NON_RECTANGULAR_PROFILE` | This shape is not a simple rectangle, so the quantity is approximate. | ⚠ Check |
| `OPENING_DEDUCTION_UNAVAILABLE` | Openings such as doors and windows could not be deducted, so the quantity is over-stated. | ⚠ Check |
| `UNKNOWN_STOREY` | We could not tell which floor this belongs to. Please assign it to a storey. | ⚠ Check |
| `DXF_LAYER_NOT_MAPPED` | The layer "{layer}" is not in our layer list, so the items on it were not measured. What is this layer? | ⚠ Check |
| `DXF_ENTITY_NOT_MEASURABLE` | This object cannot be measured (an open shape, text or a block). No quantity was taken. | ⚠ Check |
| `DXF_POLYLINE_NOT_CLOSED` | An outline on the drawing is not closed, so its size could not be worked out. Close it and upload it again. | ⚠ Check |
| `WBS_NAME_HEURISTIC` | The bill group was decided from the item name or the layer only, not checked against the model. Please check it. | ⚠ Check |
| `COEFFICIENT_MISSING` | The material-per-unit factor is missing, so the material totals are incomplete. | ⚠ Check |
| `COEFFICIENT_BASIS_MISMATCH` | The material-per-unit factor does not match this item. | ⚠ Check |
| `COEFFICIENT_PARTIAL_COVERAGE` | The material-per-unit factor only covers part of this item. | ⚠ Check |
| `LOW_CONFIDENCE` | A loose text match, not an exact item number. Verify before use. | ⚠ Check |
| `GEOMETRY_COMPUTED` | Measured from the drawing geometry. | ℹ Info |
| `IFC_QTO_SET` | Taken from the quantities in the IFC file. | ℹ Info |
| `SCHEDULE_VALUE` | Taken from a schedule on the drawing. | ℹ Info |
| `DERIVED_FROM_COEFFICIENT` | Calculated from another item using a material-per-unit factor. | ℹ Info |
| `EXACT_CODE_HIT` | Exact rate match. | ℹ Info |
| `DESCRIPTION_MATCH_HIGH` | Rate matched from the description. Worth a check. | ℹ Info |
| `CALIBRATED_BY_USER` | Calibration confirmed by you. | ℹ Info |
| `CALIBRATED_FROM_TITLE_BLOCK` | Calibration read from the title block. | ℹ Info |
| `CALIBRATED_FROM_GEOMETRY_UNITS` | Calibration taken from the drawing's own units. | ℹ Info |
| `HUMAN_OVERRIDE` | Changed by a reviewer. | ℹ Info |
| `LLM_CLASSIFIED` | Classified automatically. | ℹ Info |

**Match tiers, in words**

| Tier | What the user reads | Colour |
|---|---|---|
| `exact_code` | Rate confirmed. | green |
| `matched` | Probably right — spot-check the item number. | green |
| `needs_review` | A guess — verify before use. | amber |
| `unmatched` | No rate found — see the note on this line. | red |
| *(line kept out of the total)* | Kept out of the total: the quantity is shown, the amount is excluded until the rate is settled. | red |

**A note on `level` being empty.** The service has no `UNKNOWN_LEVEL` constant
(§1.7.9). When `level` is `""` the portal renders the storey as
**"Level not stated"** and shows the `UNKNOWN_STOREY` note if it is present.

### 3.5 The fixed copy blocks

**The SAMPLE banner (one sentence, everywhere):**

> ⚠ **SAMPLE RATES — NOT A VALUED BOQ**
> The rates shown are placeholder data, not CPWD, TN PWD or CSR rates.
> Quantities are taken only from the files listed below.
> **Not for tender, not for client issue, not for construction.**

**The DRAFT variant** (when `data_status === "DRAFT"`):

> ⚠ **DRAFT RATES — NOT FOR ISSUE**
> The rate data behind this take-off is a draft. Quantities are measured from
> your drawings; the prices are not final.
> **Not for tender, not for client issue, not for construction.**

**Where the banner must appear** — a file gets detached from the screen and a
tab gets separated from the workbook, so every surface carries it:

| Surface | How |
|---|---|
| The review screen | A non-dismissible banner above everything, and again above the total |
| The amount column | The header reads **"Amount (sample rate)"** |
| The export file name | `SAMPLE_ACS-BOQ_{project}_Rev{n}_{yyyy-mm-dd}.xlsx` |
| The workbook | The banner is in the **header and the footer of every sheet**, not only the first |
| The sheet tab names | `BOQ (SAMPLE)` / `ABSTRACT (SAMPLE)` |
| The email subject and first line | `[SAMPLE RATES — NOT FOR ISSUE]` (only if a mail path is ever added) |

The banner may drop **only** when the rate book is real, the production mode
is on, and the user ticks *"I have verified the rate book and its edition."*

**The REAL variant** (when `data_status === "REAL"` **and**
`production_mode === true`):

> ✅ **REAL RATES** — priced from {sor source}, {edition or "edition not
> recorded"}. Check the flagged lines before you issue this.

**Why both conditions:** `data_status === "REAL"` alone is not enough — a
service can hold real rates and still be running with `production_mode: false`.
The portal computes one derived value and uses it everywhere:

```
effectiveStatus = (data_status === "REAL" && production_mode === true) ? "REAL" : data_status
```

**Other fixed copy**

| Situation | Copy |
|---|---|
| No project | "You are not assigned to any project yet. Ask your admin to add you to one." |
| No drawings in the project | "This project has no drawings uploaded yet. Upload a DXF or IFC to get started." |
| PDF picked | "PDF drawings cannot be measured yet — the service reads IFC and DXF only. It is listed here so you know it is there." |
| DWG picked | "DWG is not supported. Convert it to DXF first (ODA File Converter or LibreDWG)." |
| Scale missing | "Confirm the drawing scale to continue." |
| Scale differs between drawings | "{A} and {B} are at different scales. They will be measured as two separate BOQs." |
| Service waking | "The drawing service is waking up. This can take a minute the first time you use it after a break." |
| Job failed — interrupted | "The drawing service restarted while this was running, so the job was stopped. Run it again — nothing you entered was lost." |
| Job failed — uncalibrated | "The drawing scale was not confirmed, so this drawing could not be measured. Confirm the scale and run it again." |
| Job failed — unsupported file | "We could not read {filename}. We can measure IFC and DXF files only." |
| Job lost (404) | "The drawing service forgot this job (it restarts and loses unfinished work). Run it again." |
| Export acknowledgement | "I understand these rates are placeholders and this file is not for issue." |
| Correction without a reason | "Give a reason for the change — it goes in the audit trail with your name." |
| Check points still open | "{n} check points on this BOQ have not been looked at yet." |
| Check points open at export | "{n} check points are still open. You can still export, but mark this BOQ as unchecked." |
| Item kept out of the total | "Kept out of the total: the quantity is shown, the amount is excluded until the rate is settled." |

### 3.6 The quantity-surveyor's additions (coverage, derived quantities, correction, change log)

These four panels come straight from the practitioner review and are what turns
"a table of numbers" into something an estimator can hand on.

#### 3.6.1 "What this number covers" — the card that travels with the total

```
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │ WHAT THIS NUMBER COVERS                                               │  │
│  │ Total of priced items only — not the project cost.                    │  │
│  │                                                                      │  │
│  │  Priced            214 of 260 lines                    82% priced      │  │
│  │  Kept out of total 46 lines                                                │  │
│  │    · No rate in any schedule ......... 28                               │  │
│  │    · Unit did not match the rate ...... 11                              │  │
│  │    · Not under a bill group ............ 4                              │  │
│  │    · Sample rate blocked ............... 3                              │  │
│  │                                                                      │  │
│  │  Files measured   BlockA_Ground_Plan.dxf, BlockA_Section_AA.dxf        │  │
│  │  Files not measured  BlockA_Site_Plan.dxf  (not in a bill group)      │  │
│  │                                                                      │  │
│  │  NOT INCLUDED IN THIS TAKE-OFF                                         │  │
│  │  Site works · Earthwork · Doors and windows · Finishes ·              │  │
│  │  Preliminaries · Escalation · GST · Contingency                       │  │
│  │  These are only counted if they are modelled in the drawing file.     │  │
│  │                                                                      │  │
│  │  Additional exclusions (your note):  [ ______________________ ]        │  │
│  │                                                                      │  │
│  │  Calibration  1:100, confirmed by Adithya M on 26 Oct 2026, 14:20      │  │
│  │  Known dimension  grid spacing 6.0 m (recorded, not checked)          │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
```

Every number in that card comes from the snapshot except the two portal-owned
lines (**NOT INCLUDED** and **Additional exclusions**), because the service
cannot know what was never modelled (§2.2 D12). The card is printed on the
first sheet of the export, under the banner.

#### 3.6.2 Derived quantities and material totals

The service already produces `derivations[]` and `materials[]` (shuttering,
reinforcement and material roll-ups derived from other lines). The portal
renders them in a collapsible panel **under** the line list, never merged into
it — a derived line is a measurement of a measurement, and the QS must be able
to see that it is not a direct measurement.

```
│  ▸ Derived quantities (4)                                              │
│  │  Shuttering to RCC        38.44 m2   from 3 concrete lines            │  │
│  │  Reinforcement (estimated) 4.82 t    from 3 concrete lines            │  │
│  │  Plaster (internal)       612.10 m2  from 6 wall lines                │  │
│  │  …                                                                  │  │
│  │  ⚠ Derived from other lines using a material-per-unit factor.        │  │
│  │    Verify against the drawings before use.                            │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│  ▸ Material totals                                                      │
│  │  Cement 18.4 t · Steel 4.82 t · Sand 12.1 m3 · Aggregate 61.0 m3     │  │
```

#### 3.6.3 The correction drawer — reason is a dropdown

```
│  │  LINE 24   RCC — Column 300 × 300 mm            [ ⚠ 2 check points ]  │  │
│  │  Storey: Ground Floor · Bill group: RCC · Unit: m3                    │  │
│  │                                                                      │  │
│  │  Quantity        12.480  m3                                          │  │
│  │  Base rate       5,240.00 (sample)                                   │  │
│  │  Amount          65,395.20 (sample rate)                             │  │
│  │  Rate match      Probably right — spot-check the item number          │  │
│  │  Check points    Size was not in the model, so an assumed size was    │  │
│  │                  used. Please confirm the size.                       │  │
│  │  How it was measured  24.960 m2 × 0.500 m = 12.480 m3                 │  │
│  │  Trace  file: BlockA_Ground_Plan.dxf · element: COLUMN_B4            │  │
│  │                                                                      │  │
│  │  CORRECT THIS LINE                                                   │  │
│  │  [ Correct the item ] [ Fix quantity ] [ Assign storey ]             │  │
│  │                                                                      │  │
│  │  Reason (required)                                                   │  │
│  │  ( ) Checked against the drawing   ( ) Measured on site               │  │
│  │  ( ) As per site instruction       ( ) As per client email (date)    │  │
│  │  ( ) Rate basis changed            ( ) Duplicate — removed            │  │
│  │  Note (optional)  [ ______________________________ ]                  │  │
│  │                                                                      │  │
│  │  This change is recorded with your name, the time, the file and the   │  │
│  │  element, and it appears in the change log.                          │  │
│  │                                       [ Cancel ]  [ Save change ]     │  │
```

Rules: the **reason is required** (the service requires it too); the note is
optional; **"Save" is disabled until a reason is picked**; the change is
written to the service first (`PATCH /jobs/{id}/lines/{line_id}`) and the
portal's snapshot is refreshed from the service's response — never patched
locally.

#### 3.6.4 The change log (audit trail)

Rendered from the snapshot's `corrections[]` (oldest first), **immutable**:

```
│  CHANGE LOG                                                             │
│  26 Oct 14:20  Adithya M      Quantity  11.200 → 12.480 m3              │
│               Checked against the drawing — grid spacing 6.0 m          │
│               line 24 · BlockA_Ground_Plan.dxf · element COLUMN_B4       │
│  26 Oct 14:31  Adithya M      Item      SAMPLE-009 → SAMPLE-014         │
│               As per client email (date) - 24 Oct                        │
│               line 24 · BlockA_Ground_Plan.dxf                           │
```

Nothing in the portal can edit or delete a row here — the trail is the
snapshot's, and a new revision of the snapshot is a new immutable record.

---

## 4. The user flow and the navigation change

### 4.1 The flow, end to end

```
Sidebar "Tools" → BOQ Generator
   │
   ├─ 1. Pick a project          (assigned projects only)
   │      └─ no project? empty state, ask an admin
   │
   ├─ 2. Choose drawings
   │      ├─ from the project's attachments (category DESIGN_DRAWINGS)
   │      └─ upload new IFC/DXF  → presigned PUT straight to R2
   │
   ├─ 3. Confirm settings
   │      ├─ scale per drawing (REQUIRED for DXF) ── differing scales → split
   │      ├─ rate source (from /meta, marked SAMPLE)
   │      └─ wastage % (advanced)
   │
   ├─ 4. Generate
   │      ├─ portal creates a BoqJob row (idempotency key reserved)
   │      ├─ portal mints a 10-min presigned GET per file
   │      ├─ portal POSTs /jobs to the service with sources[]
   │      └─ 202 → serviceJobId stored
   │
   ├─ 5. Wait (browser polls the portal; the portal polls the service)
   │      ├─ queued / running → the waiting screen
   │      ├─ done → the portal fetches snapshot + xlsx and stores both
   │      └─ failed → the failure screen with the plain-language reason
   │
   ├─ 6. Review
   │      ├─ grouped lines, flagged first
   │      ├─ line drawer → correction with a reason → the service PATCH
   │      ├─ the portal re-fetches the snapshot and writes a new revision
   │      └─ audit trail from the snapshot's corrections[]
   │
   └─ 7. Save & download
          ├─ acknowledge the sample notice
          ├─ the stored .xlsx is downloaded from R2
          └─ the acknowledgement is logged
```

### 4.2 The navigation change, in full

| What | Where | Change |
|---|---|---|
| New SVG const | `src/components/PortalLayout.jsx` (near the other icons, ~line 140-278) | `BOQ_GENERATOR_ICON` — the calculator glyph in §1.1 |
| New group | `src/components/PortalLayout.jsx`, `navGroups` | Insert **between** the "My Reports" group (ends line 345) and the admin spread (line 347): `{ label: 'Tools', items: [{ to: '/portal/boq-generator', label: 'BOQ Generator', icon: BOQ_GENERATOR_ICON }] }` |
| New route | `src/App.jsx` | `<Route path="boq-generator" element={<BoqGenerator />} />` inside the `/portal` route, plus the lazy import |
| New page | `src/pages/portal/BoqGenerator.jsx` | The whole screen |
| Mobile | — | **No change.** The drawer renders the same `navGroups`. The bottom tab bar is a hardcoded 5-link list and is left alone. |
| Pilot gate (optional) | `src/components/PortalLayout.jsx` | If `BOQ_PILOT_EMPLOYEE_IDS` is set, the item is filtered out for non-pilot employees; the route returns the "pilot access only" page. The pilot list is fetched from `GET /api/boq-generator/access` and cached in the auth context. |

**Route naming:** `/portal/boq-generator`, deliberately **not** `/portal/boq` —
that is the existing "BOQ Variance" page and the two must never be confused.
The backend mounts at `/api/boq-generator`, deliberately **not** `/api/boq` —
that is the existing `BoqItem` API and its error shape differs.

---

## 5. API usage map

### 5.1 Portal routes (all new, under `/api/boq-generator`)

| # | Screen action | Portal route | Service call | Notes |
|---|---|---|---|---|
| 1 | Page opens | `GET /api/boq-generator/meta` | `GET /meta` (cached 5 min) | Returns `data_status`, `production_mode`, `effectiveStatus`, `sor_sources[]`, `wbs_groups[]`, `limits`, `supported_input_types`. Also returns whether this employee is in the pilot cohort. |
| 2 | Project list | *existing* `GET /api/projects?scope=assigned` | — | Reuse. No new route. |
| 3 | Existing drawings | *existing* `GET /api/projects/:projectId/attachments?category=DESIGN_DRAWINGS` | — | Reuse. |
| 4 | Request an upload URL | `POST /api/boq-generator/uploads/presign` | — | Body: `{ projectId, filename, sizeBytes }`. Returns `{ uploadId, sasUrl, blobPath, expiresAt }`. Server derives the extension from an allowlist (`dxf`, `ifc`) and **binds `application/octet-stream`** so the browser need not guess a type. |
| 5 | Confirm an upload | `POST /api/boq-generator/uploads/confirm` | — | Body: `{ uploadId }`. Server `HEAD`s the blob, checks the length matches exactly, and **sniffs the first bytes** (`AutoCAD Binary DXF`, `ISO-10303-21`, ASCII DXF) — a PDF renamed to `.dxf` is rejected here, before a job is ever created. |
| 6 | Create a job | `POST /api/boq-generator/jobs` | `POST /jobs` | Body: `{ projectId, uploads: [uploadId…], dxfScale, rateSource, wastagePct }`. **Requires the `Idempotency-Key` header** (client-generated, ≤128 chars). |
| 7 | Poll status | `GET /api/boq-generator/jobs/:boqJobId` | `GET /jobs/{serviceJobId}` | The browser polls **the portal**, not the service. The portal calls the service at most once per poll. On `done`, the portal fetches and stores the snapshot + xlsx (§5.4). |
| 8 | Read the BOQ | `GET /api/boq-generator/jobs/:boqJobId/boq` | `GET /jobs/{id}/boq` **or** the stored snapshot | Served from the stored snapshot when the service is gone. |
| 9 | Correct a line | `POST /api/boq-generator/jobs/:boqJobId/lines/:lineId/corrections` | `PATCH /jobs/{id}/lines/{line_id}` | Body: `{ kind, reason, value… }`. The portal adds `requested_by` itself (never from the client). |
| 10 | Save (freeze) | `POST /api/boq-generator/jobs/:boqJobId/save` | `GET /snapshot` + `GET /boq.xlsx` | Fetches both back-to-back, stores both in R2, writes a `BoqSnapshot` row. Idempotent. |
| 11 | Download the export | `GET /api/boq-generator/jobs/:boqJobId/export` | — | Serves the stored `.xlsx` from R2 via a 10-minute presigned GET. `410 BOQ_EXPORT_GONE` if the blob is missing and regeneration also fails. |
| 12 | Regenerate the export | `POST /api/boq-generator/jobs/:boqJobId/export/regenerate` | — | Rebuilds a workbook from the stored snapshot JSON using `exceljs` (already a dependency). Marked "regenerated from the saved snapshot" in the filename. |
| 13 | Delete a job | `DELETE /api/boq-generator/jobs/:boqJobId` | `DELETE /jobs/{id}` | Deletes the portal row, the R2 objects and the service job. |
| 14 | Pilot gate | `GET /api/boq-generator/access` | — | `{ isPilot, pilotEnabled }`. |
| 15 | Cron reconcile | `POST /api/internal/boq-reconcile` | `GET /jobs/{id}` | Internal-token protected, like the other `internal-*` routes. Sweeps jobs that are still in flight or that completed but were never snapshotted. |

### 5.2 The outbound call to the service

```js
// backend/src/lib/boqClient.js  (sketch — not written yet)
const BASE = process.env.BOQ_BASE_URL;              // https://acs-boq-generator.onrender.com
const TOKEN = process.env.BOQ_API_TOKEN;            // the service's bearer token
```

| Aspect | Value | Why |
|---|---|---|
| Auth header | `Authorization: Bearer ${TOKEN}` | The service's only auth. |
| Timeout | **180 s** on `POST /jobs`; **75 s** on `GET /jobs/{id}`; **30 s** on `/meta` | `src/lib/api.js`'s 30 s default is far too short: a cold start is ~60 s, and the service's own 60 s fetch happens *inside* `POST /jobs`. |
| `X-Request-ID` | the portal's own request id, ≤128 chars | The service echoes it back; it makes a call traceable across both systems. |
| `Idempotency-Key` | `boq:${boqJob.id}` — **derived from the portal's job id, never the client's raw key** | See §5.3. |
| Retry | **No automatic retry on `POST /jobs` inside one request.** The portal retries on the *next* client poll, with the same derived key. | The service's idempotency makes a repeat safe (§5.3). |
| Rate limit | The portal's own per-employee limiter, plus a global cap of **5 in-flight jobs** | The service's 240/min limit is **per token** (`app/api/ratelimit.py` — *"one bucket per token"*), so it is shared by every employee; and it is one SQLite writer on one free instance. 5 jobs × 20 polls/min = 100/min, comfortably inside 240. |
| Errors | `{"error": {"code", "message", "details"}}` → mapped to the portal's flat `{ error, code, message }` shape | The portal's own error shape is flat ([drawingLink.js:38](../backend/src/lib/drawingLink.js#L38)). |

### 5.3 Idempotency — the two layers and why they do not deadlock

```
client ──Idempotency-Key: K──▶ POST /api/boq-generator/jobs
                                    │
                                    ├─ reserve K in `request_dedupe`
                                    │     namespace `boq-job-create:${employeeId}:${K}`
                                    │     body-hash pinned → same key + different body = 409
                                    │     (idempotency.js, DR-020/DR-006)
                                    │
                                    ├─ create BoqJob row (idempotencyKey = K)
                                    │
                                    └─ derive service key = `boq:${boqJob.id}`
                                          │
                                          └─ POST /jobs  ──Idempotency-Key: boq:<id>──▶ service
```

**The rule: retry the outbound `POST /jobs` with the same derived key whenever
`serviceJobId IS NULL`.**

- The service still has the key → it returns the original job (202 with
  `idempotent_replay: true`). No duplicate work.
- The service lost it (cold start wiped SQLite) → it creates a **new** job.
  That is correct: the old job was unrecoverable anyway.
- The portal never needs to know which happened. The "use a NEW key" caveat in
  the service README only matters if you want to tell two *attempts* apart —
  and that distinction belongs to the portal's own row and attempt counter,
  not to the service.

**Why this is not a double lock:** the two layers are **parent and child**, not
peers. The portal layer guarantees *one outbound POST per (employee, key)*.
The service layer guarantees *one job per outbound POST*, even when the
portal's own HTTP call times out. Neither waits on the other.

**TTL note:** the portal's idempotency identity TTL is 720 h (30 d) and the
service's job retention is 168 h (7 d). The mismatch is harmless given the rule
above.

**No idempotency key on the poll, the read, the correction or the save.** Those
are naturally idempotent or are protected by the `revision` counter (§8.2).

### 5.4 Polling, backoff and the completion sweep

**Browser → portal:**

| Elapsed since submit | Interval |
|---|---|
| 0–15 s | every 2 s |
| 15–60 s | every 4 s |
| 60 s–5 min | every 8 s |
| > 5 min | every 15 s |
| > 15 min | every 30 s |

Stops on `done`, `failed`, or when the tab is hidden (the browser pauses
polling on `visibilitychange`; the portal's own reconcile cron covers the gap).

**Portal → service:** at most one `GET /jobs/{id}` per incoming poll per job.
No background loop — a Render free instance's in-process timer dies with the
instance and burns instance-hours.

**On observing `done`, the portal immediately, server-side:**

1. `GET /jobs/{id}/snapshot` → write the JSON to R2 `snapshots/{projectId}/{boqJobId}/rev-{n}.json` → write a `BoqSnapshot` row.
2. `GET /jobs/{id}/boq.xlsx` → write the bytes to R2 `exports/{projectId}/{boqJobId}/boq-{boqJobId}-rev-{n}.xlsx` → point the snapshot row at it.
3. Mark the `BoqJob` `COMPLETED`.

**If step 2 fails** (the service died between the two calls): the snapshot is
already stored, so the portal retries **only the xlsx** on the next poll and
on the reconcile cron. **It never re-runs the job.** The UI says *"The
spreadsheet is still being prepared — the BOQ itself is safe."*

**If the service has forgotten the job** (`404 JOB_NOT_FOUND`): the `BoqJob`
is marked `LOST`, the user sees *"The drawing service forgot this job… Run it
again"*, and **any snapshot we already stored is kept and still downloadable**.
The portal does **not** auto-retry — a retry would create a second service job
and burn the single-instance queue.

**The reconcile cron** (a GH Actions workflow, like the existing
`cron-upload-sweep.yml`): once a day, plus on demand, it asks the portal for
jobs in `SUBMITTED`/`RUNNING`/`COMPLETED_PENDING_EXPORT` and reconciles them
against the service. This closes the "the user closed the tab for two days"
gap well inside the 168-hour service retention.

### 5.5 Error mapping — every service error, and what the user sees

| Service code | Portal HTTP | Portal code | What the user sees |
|---|---|---|---|
| `AUTH_REQUIRED` | 502 | `BOQ_SERVICE_UNAVAILABLE` | "The drawing service rejected our request. Please tell your admin." *(never leaks the token)* |
| `VALIDATION_ERROR` | 400 | `BOQ_VALIDATION` | "Some of the drawing details were not accepted." + the service's message |
| `NOT_FOUND` (bad `line_id`) | 409 | `BOQ_LINE_GONE` | "That line is no longer in the drawing set. Reload the BOQ." |
| `JOB_NOT_FOUND` | 409 | `BOQ_JOB_LOST` | "The drawing service forgot this job. Run it again." |
| `UNSUPPORTED_FILE_TYPE` | 400 | `BOQ_UNSUPPORTED_FILE` | "We could not read {filename}. We can measure IFC and DXF files only." |
| `PDF_NOT_SUPPORTED` | 400 | `BOQ_PDF_UNSUPPORTED` | "PDF drawings cannot be measured yet." |
| `UPLOAD_TOO_LARGE` / `REQUEST_TOO_LARGE` | 413 | `BOQ_FILE_TOO_LARGE` | "The file is over the 100 MB limit." |
| `TOO_MANY_SOURCES` | 400 | `BOQ_TOO_MANY_FILES` | "A run can take at most 20 files. Select fewer, or split the run." |
| `PRODUCTION_DATA_BLOCKED` | 409 | `BOQ_PRODUCTION_BLOCKED` | "The drawing service is configured to refuse this data. Tell your admin." |
| `JOB_NOT_READY` | 409 | `BOQ_NOT_READY` | *(internal only — the browser never asks for a BOQ that is not done)* |
| `JOB_FAILED` | 409 | `BOQ_JOB_FAILED` | *(internal only)* |
| `CORRECTION_REFUSED` | 409 | `BOQ_CORRECTION_REFUSED` | "That change would put a quantity in the wrong unit, so it was not applied." |
| `RATE_LIMITED` | 429 | `BOQ_SERVICE_BUSY` | "The drawing service is busy. Try again in a minute." |
| `IDEMPOTENCY_CONFLICT` | 409 | `BOQ_CONFLICT` | "This request is already being processed. Refresh the page." |
| `FETCH_*` (all twelve) | 502 | `BOQ_FETCH_FAILED` | "The drawing service could not read the file we sent it. Try again." |
| `INTERNAL_ERROR` | 502 | `BOQ_SERVICE_ERROR` | "Something went wrong in the drawing service. Try again." |
| *(job record)* `SOURCE_UNCALIBRATED` | 409 | `BOQ_UNCALIBRATED` | "The drawing scale was not confirmed, so this drawing could not be measured." |
| *(job record)* `JOB_INTERRUPTED` | 409 | `BOQ_INTERRUPTED` | "The drawing service restarted while this was running. Run it again." |
| *(job record)* `INTERNAL_ERROR` | 502 | `BOQ_SERVICE_ERROR` | "Something went wrong in the drawing service. Try again." |
| network / timeout | 504 | `BOQ_TIMEOUT` | "The drawing service took too long to answer. It may still be working — try again in a minute." |

The mapper reads `error.details` **defensively**: it is an object in the HTTP
envelope but a **list of strings** in the job record.

---

## 6. Data model

### 6.1 The two models

Both are **additive-only**. Neither touches `BoqItem` or `/api/boq`.

```prisma
// ─────────────────────────────────────────────────────────────────────────────
// BOQ Generator — job record. One row per generation attempt.
//
// Additive-only: new table, new columns. BoqItem and /api/boq are untouched.
// ─────────────────────────────────────────────────────────────────────────────
model BoqJob {
  id          String   @id @default(uuid())
  employeeId  String   @map("employee_id")
  projectId   String   @map("project_id")
  // The service's job id (uuid4 hex). NULL until POST /jobs returns 202.
  // NEVER sent to the browser and NEVER accepted as a route parameter.
  serviceJobId String? @map("service_job_id")
  status      String   @default("DRAFT") @map("status")
  // DRAFT | SUBMITTED | RUNNING | COMPLETED | COMPLETED_PENDING_EXPORT
  // | FAILED | LOST | DELETED
  dataStatus  String?  @map("data_status")          // REAL | DRAFT | SAMPLE
  productionMode Boolean? @map("production_mode")
  // The scale the reviewer confirmed, as a denominator (100 = 1:100).
  // Per-drawing scales live in `inputFiles`; this is the single scale sent
  // to the service for this job.
  dxfScale    Float?   @map("dxf_scale")
  scaleConfirmedBy String? @map("scale_confirmed_by")
  scaleConfirmedAt DateTime? @map("scale_confirmed_at")
  // The client's Idempotency-Key, namespaced under the employee id in
  // request_dedupe. Retained for the audit trail.
  idempotencyKey String? @map("idempotency_key")
  // Monotonic counter used to detect a stale correction (409).
  revision    Int      @default(1) @map("revision")
  // The settings actually sent, for the audit trail.
  settingsJson Json?   @map("settings_json")
  // [{ uploadId, filename, contentType, sizeBytes, sha256, blobPath,
  //    drawingId?, level?, dxfScale? }]
  inputFiles  Json     @map("input_files")
  errorCode   String?  @map("error_code")
  errorMessage String? @map("error_message")
  errorDetails Json?   @map("error_details")
  startedAt   DateTime? @map("started_at")
  completedAt DateTime? @map("completed_at")
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")

  employee   Employee @relation("BoqJobEmployee", fields: [employeeId], references: [id], onDelete: Cascade)
  project    Project  @relation("BoqJobProject", fields: [projectId], references: [id], onDelete: Cascade)
  snapshots  BoqSnapshot[]

  @@index([employeeId, createdAt])
  @@index([projectId, createdAt])
  @@index([status])
  @@unique([employeeId, idempotencyKey])
  @@map("boq_job")
}

// ─────────────────────────────────────────────────────────────────────────────
// BOQ Generator — the permanent record. APPEND-ONLY: one row per revision.
//
// revision 1 = as generated by the service.
// revision n+1 = after a correction batch.
//
// The snapshot JSON itself lives in R2 (blobPath); this row holds the
// scalars the list view needs, so a 20-row job list never pulls megabytes.
// ─────────────────────────────────────────────────────────────────────────────
model BoqSnapshot {
  id          String   @id @default(uuid())
  boqJobId    String   @map("boq_job_id")
  revision    Int      @map("revision")
  schemaVersion String @map("schema_version")   // "1.0"
  kind        String   @default("acs.boq.snapshot")
  serviceVersion String? @map("service_version")
  dataStatus  String   @map("data_status")
  productionMode Boolean @map("production_mode")
  currency    String   @default("INR")
  totalsAmount Decimal? @map("totals_amount") @db.Decimal(15, 2)
  lineCount   Int      @default(0) @map("line_count")
  withheldCount Int    @default(0) @map("withheld_count")
  // R2 key of the snapshot JSON document. Never expires.
  snapshotBlobPath String @map("snapshot_blob_path")
  // R2 key of the workbook, when it was produced. NULL if the export failed.
  exportBlobPath  String? @map("export_blob_path")
  // The scale + who confirmed it, copied from the snapshot's `scale` block.
  dxfScale   Float? @map("dxf_scale")
  scaleConfirmedBy String? @map("scale_confirmed_by")
  // The export acknowledgement: who accepted the SAMPLE warning, and when.
  acknowledgedById String? @map("acknowledged_by_id")
  acknowledgedAt   DateTime? @map("acknowledged_at")
  savedById  String  @map("saved_by_id")
  createdAt  DateTime @default(now()) @map("created_at")

  boqJob BoqJob @relation(fields: [boqJobId], references: [id], onDelete: Cascade)

  @@unique([boqJobId, revision])
  @@index([boqJobId])
  @@map("boq_snapshot")
}
```

### 6.2 Exactly what is stored where

| Thing | Where | Why there |
|---|---|---|
| The BOQ **document** (the full snapshot JSON) | **R2** `boq-generator/snapshots/{projectId}/{boqJobId}/rev-{n}.json` | It is 100 KB–2 MB. Keeping it in Postgres would bloat the job list. It must never expire — it is the record. |
| The BOQ **spreadsheet** | **R2** `boq-generator/exports/{projectId}/{boqJobId}/boq-{boqJobId}-rev-{n}.xlsx` | The exact file the user reviewed. Re-fetching later from the service would silently produce a *different* file (the service regenerates from the current view), which would make the audit trail fiction. |
| The **original drawings** | **R2** `boq-generator/drawings/{projectId}/{employeeId}/{ulid}.{ext}` | Working copies. The BOQ is the product; the drawing belongs to ACS. The key carries the employee id because the drawing is uploaded before the job exists; the job→drawing link is the `boq_job.inputFiles` row. |
| The snapshot **metadata** (totals, counts, status, paths, who/when) | **Postgres** `boq_snapshot` | Cheap to list, cheap to filter, immutable. |
| The **job** (status, settings, scale, files, error) | **Postgres** `boq_job` | The portal's index of service jobs — the service has no "list my jobs" endpoint. |
| The **correction trail** | Inside the snapshot's `corrections[]` (in R2) | The service already provides the whole trail, oldest first, with who/when/old/new/reason. No third table. |
| The service's own copy | The service's ephemeral SQLite | Disposable by design. |

### 6.3 The migration

Two migrations, or one — the choice is yours. The repo's convention is one
migration per logical change, with a `DO $$ … $$` verification block at the end
(the DR-031 lesson: a half-applied security posture must fail loudly).

**Migration A — create the tables.**

```sql
BEGIN;

CREATE TABLE IF NOT EXISTS public.boq_job (
  id                UUID PRIMARY KEY,
  employee_id       TEXT NOT NULL REFERENCES public.employee(id) ON DELETE CASCADE,
  project_id        TEXT NOT NULL REFERENCES public.project(id) ON DELETE CASCADE,
  service_job_id    TEXT,
  status            TEXT NOT NULL DEFAULT 'DRAFT',
  data_status       TEXT,
  production_mode   BOOLEAN,
  dxf_scale         DOUBLE PRECISION,
  scale_confirmed_by TEXT,
  scale_confirmed_at TIMESTAMPTZ,
  idempotency_key   TEXT,
  revision          INTEGER NOT NULL DEFAULT 1,
  settings_json     JSONB,
  input_files       JSONB NOT NULL DEFAULT '[]'::jsonb,
  error_code        TEXT,
  error_message     TEXT,
  error_details     JSONB,
  started_at        TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT boq_job_employee_idempotency_key_uniq UNIQUE (employee_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS boq_job_employee_created_at_idx ON public.boq_job (employee_id, created_at DESC);
CREATE INDEX IF NOT EXISTS boq_job_project_created_at_idx ON public.boq_job (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS boq_job_status_idx              ON public.boq_job (status);

CREATE TABLE IF NOT EXISTS public.boq_snapshot (
  id                UUID PRIMARY KEY,
  boq_job_id        UUID NOT NULL REFERENCES public.boq_job(id) ON DELETE CASCADE,
  revision          INTEGER NOT NULL,
  schema_version    TEXT NOT NULL,
  kind              TEXT NOT NULL DEFAULT 'acs.boq.snapshot',
  service_version   TEXT,
  data_status       TEXT NOT NULL,
  production_mode   BOOLEAN NOT NULL DEFAULT false,
  currency          TEXT NOT NULL DEFAULT 'INR',
  totals_amount     DECIMAL(15,2),
  line_count        INTEGER NOT NULL DEFAULT 0,
  withheld_count    INTEGER NOT NULL DEFAULT 0,
  snapshot_blob_path TEXT NOT NULL,
  export_blob_path   TEXT,
  dxf_scale         DOUBLE PRECISION,
  scale_confirmed_by TEXT,
  acknowledged_by_id TEXT REFERENCES public.employee(id) ON DELETE SET NULL,
  acknowledged_at   TIMESTAMPTZ,
  saved_by_id       TEXT NOT NULL REFERENCES public.employee(id) ON DELETE RESTRICT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT boq_snapshot_job_revision_uniq UNIQUE (boq_job_id, revision)
);

CREATE INDEX IF NOT EXISTS boq_snapshot_boq_job_id_idx ON public.boq_snapshot (boq_job_id);
```

**Migration B — the RLS lockdown**, following the pattern in
[`20261002010002_payslip_rls/migration.sql`](../backend/prisma/migrations/20261002010002_payslip_rls/migration.sql)
exactly:

```sql
BEGIN;

ALTER TABLE public.boq_job     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.boq_snapshot ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS boq_job_deny_anon           ON public.boq_job;
DROP POLICY IF EXISTS boq_job_deny_authenticated   ON public.boq_job;
DROP POLICY IF EXISTS boq_snapshot_deny_anon      ON public.boq_snapshot;
DROP POLICY IF EXISTS boq_snapshot_deny_authenticated ON public.boq_snapshot;

CREATE POLICY boq_job_deny_anon ON public.boq_job
  FOR ALL TO anon USING (false) WITH CHECK (false);
CREATE POLICY boq_job_deny_authenticated ON public.boq_job
  FOR ALL TO authenticated USING (false) WITH CHECK (false);

CREATE POLICY boq_snapshot_deny_anon ON public.boq_snapshot
  FOR ALL TO anon USING (false) WITH CHECK (false);
CREATE POLICY boq_snapshot_deny_authenticated ON public.boq_snapshot
  FOR ALL TO authenticated USING (false) WITH CHECK (false);

-- Loud safety net (copied from the payslip migration): refuse to commit if
-- RLS is off or the policy count is not exactly 2 on each table.
DO $$
DECLARE rls_enabled boolean; policy_count integer;
BEGIN
  SELECT relrowsecurity INTO rls_enabled FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'boq_job';
  IF rls_enabled IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'RLS not enabled on public.boq_job';
  END IF;
  SELECT count(*) INTO policy_count FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'boq_job';
  IF policy_count <> 2 THEN
    RAISE EXCEPTION 'expected exactly 2 policies on public.boq_job, found %', policy_count;
  END IF;
  -- ... the same two checks for public.boq_snapshot ...
END $$;

COMMIT;
```

**Why deny-all:** PostgREST auto-exposes every `public`-schema table to anyone
holding the public anon key. The `postgres` role has `rolbypassrls = TRUE`, so
the backend reads and writes normally. The deny-all policies close the
PostgREST surface without touching the app. (This is the S1 lockdown pattern;
the rotation_receipt incident in `20261002000000` is the cautionary tale.)

### 6.4 Why not "no table at all"?

The alternative — keeping everything in R2 and a JSON index — was rejected:
the portal still needs to answer *"which jobs belong to this employee on this
project, and which are still running?"* without listing R2 prefixes, and the
project-scope check must be a database-level join, not a scan.

---

## 7. R2 storage design (Step 3)

### 7.1 The bucket

| Decision | Value | Why |
|---|---|---|
| **Bucket name** | **`boq-generator`** | One bucket for drawings, snapshots and exports. Named for the feature, not for a file type, because it holds all three. |
| **Account** | the same R2 account as the existing buckets | Same account, **separate bucket, separate API token**. |
| **Region** | same as the existing buckets (R2 is regionless; the account's jurisdiction applies) | Consistency. |
| **Public access** | **Disabled.** No custom domain, no `r2.dev` subdomain. | Drawings are ACS's; a BOQ is commercially sensitive. |
| **Versioning** | Off | The portal's own `revision` is the versioning. R2 versioning would double storage and confuse the two. |
| **Object lock / retention** | Off | The portal's lifecycle rules are enough for a first version. |

### 7.2 Key structure

```
boq-generator/
  drawings/{projectId}/{employeeId}/{ulid}.{ext}        ← working copies of the drawings
  snapshots/{projectId}/{boqJobId}/rev-{n}.json         ← the permanent record
  exports/{projectId}/{boqJobId}/boq-{boqJobId}-rev-{n}.xlsx
```

**Rules**

- **The drawing key carries the employee id, not the job id — because the job
  does not exist yet when the drawing is uploaded.** The flow is *upload first,
  run second*: the user picks and uploads drawings in step 1, and the service
  job is created in step 3. The link between a drawing and a job is the
  portal's own `boq_job.inputFiles` row, not the key. Every upload is
  therefore already isolated per employee at the storage layer, which is the
  same isolation the existing `${employeeId}/${ulid}.${ext}` convention gives.
- **The original filename is never in the key.** It is stored as a *label* on
  the `BoqJob.inputFiles` row and inside the snapshot's `inputs[]`. The key
  uses a server-generated ULID, exactly like the existing
  `${employeeId}/${ulid}.${ext}` convention. This removes every
  path-traversal, unicode-normalisation and filename-injection question in one
  move.
- **The extension is server-derived from an allowlist** — `dxf` or `ifc` only —
  never taken from the client's filename. The client's filename is used only to
  *choose* the extension (`.dxf` → `dxf`, `.ifc` → `ifc`), and an unknown
  extension is rejected before a presign is minted.
- `projectId` is the portal's project uuid (already validated against the
  caller's assignment). `boqJobId` is the portal's job uuid.
- `rev-{n}` makes two revisions of the same job impossible to confuse.

### 7.3 The token — a separate, bucket-scoped API token

| | Value |
|---|---|
| **Scope** | Account `acs-portal` → bucket **`boq-generator`** only |
| **Permissions** | **Object Read & Write** on that bucket. **Not** Admin, **not** Bucket Read, **not** `CreateBucket`/`PutBucketCors`. |
| **Why not Admin** | The existing runtime credential is already least-privilege by design (the CORS/bucket-creation powers moved to `provisionR2.js`). A new bucket-scoped token follows the same rule. |
| **Why not reuse the existing credential** | Your brief requires a separate token, and it is the right call: the BOQ drawings are the most commercially sensitive files in the system, and a separate token means a leak of one does not unlock the payslip bucket. |
| **New env var names** | `R2_BOQ_ACCOUNT_ID`, `R2_BOQ_ACCESS_KEY_ID`, `R2_BOQ_SECRET_ACCESS_KEY`, `R2_BOQ_BUCKET` (default `boq-generator`) — named to match the existing `R2_*` family (`R2_ACCOUNT_ID`, `R2_BUCKET_DPR_PHOTOS`, …) |
| **The client** | A **second** `S3Client` instance in `backend/src/lib/boqClient.js` (or a new `boqBlobStorage.js`), pointed at `https://<R2_BOQ_ACCOUNT_ID>.r2.cloudflarestorage.com`. It is **not** the singleton in `blobStorage.js`. |

**The bucket host** the service must be allowed to fetch from:

```
boq-generator.{R2_BOQ_ACCOUNT_ID}.r2.cloudflarestorage.com
```

This goes into the service's `BOQ_API_FETCH_ALLOWED_HOSTS`. The matching rules
are in `app/api/fetch.py:148-171` and they are precise:

- An **exact** name matches itself.
- A name starting with `*.` matches **one or more labels** under it —
  `*.r2.cloudflarestorage.com` matches both `acct.r2.cloudflarestorage.com`
  and `boq-generator.acct.r2.cloudflarestorage.com`.
- It matches neither the bare `r2.cloudflarestorage.com` nor
  `r2.cloudflarestorage.com.example.test`.
- There is **no wildcard for "any host"**, and an **empty list refuses every
  reference fetch** (`FETCH_HOST_REFUSED`).
- The service also resolves the host and **refuses private, loopback and
  link-local addresses** (`is_public_address`), so the allow-list entry must
  be the **public** R2 hostname — never a private or custom-domain endpoint.

**Recommended allow-list entry:** `*.r2.cloudflarestorage.com` (covers the
bucket and every other bucket in the account), or the **exact** host
`boq-generator.{ACCOUNT_ID}.r2.cloudflarestorage.com` if you want the
tightest possible list. The exact host is better; the wildcard is more
forgiving if the bucket or account ever changes.

### 7.4 CORS (needed because the browser uploads directly)

| Setting | Value |
|---|---|
| Allowed origins | `https://acschennai.com`, `https://acs-portal-spa.onrender.com` |
| Allowed methods | `PUT`, `GET`, `HEAD` |
| Allowed headers | `*` |
| Expose headers | `ETag` |
| Max age | 300 s |

This matches the existing `provisionR2.js` CORS rule exactly, so the bucket is
provisioned by the same sanctioned script.

> **Important:** the presigned PUT for a BOQ drawing binds
> `Content-Type: application/octet-stream`, so the browser sends exactly that.
> `CONTENT_TYPE_EXT` in `blobStorage.js` **throws** on an unknown content type,
> so DXF/IFC cannot simply be added to that map with their real media types
> (neither `application/dxf` nor `application/x-step` is registered, and a DXF
> is often `text/plain` on some clients). The BOQ upload path therefore uses
> its own presign function with a fixed `application/octet-stream` binding,
> and the **extension allowlist + the portal's own magic-byte check** are what
> enforce the type. The service's content sniffing remains authoritative.

### 7.5 Lifecycle rules

| Prefix | Rule | Why |
|---|---|---|
| `drawings/` | **Expire after 30 days** | The service keeps its own copy for 24 h; the portal's working copy is only needed while the job is live and for a short re-run window. |
| `snapshots/` | **No expiry** (or 3 years) | This is the permanent record. |
| `exports/` | **Expire after 365 days** | A year of spreadsheets is generous; after that the export can be regenerated from the snapshot JSON with `exceljs`. |

Cloudflare R2 lifecycle rules are configured per bucket with an optional
**prefix filter**, so one bucket supports all three rules. They are set in the
**Cloudflare dashboard** (or the S3 `PutBucketLifecycleConfiguration` API) —
`provisionR2.js` does CORS and bucket creation, not lifecycle. See §11.

### 7.6 Size and type limits

| Limit | Value | Enforced by |
|---|---|---|
| Max bytes per drawing | **50 MB** (portal) / 100 MB (service) | The portal's cap is deliberately half the service's, so a file that passes the portal also passes the service's fetch within its 60 s timeout. Raise both together. |
| Max files per run | **20** | Matches `BOQ_API_MAX_SOURCES`. The portal refuses at 20 with a clear message rather than letting the service 413. |
| Max total per run | **500 MB** | Portal-side sum. |
| Allowed extensions | `.dxf`, `.ifc` | Portal-side allowlist, server-derived extension. |
| Allowed content | `AutoCAD Binary DXF`, `ISO-10303-21`, ASCII DXF | Portal-side magic-byte sniff at `confirm-upload`, **and** the service's own sniff. |
| PDF | **Refused at the file picker** with an explanation, and again at `confirm-upload`. | Two places, because the first is friendlier. |
| DWG | Refused with *"Convert it to DXF first."* | — |

### 7.7 Browser-direct upload vs. through Express — the recommendation

| Option | Verdict |
|---|---|
| **Browser → presigned PUT → R2** | ✅ **Recommended.** Matches every existing upload in the portal (DPR photos, inspection photos, project attachments, payslips). 50 MB never touches the Render backend. The portal only issues and verifies URLs. |
| **Browser → Express → R2** | ❌ A 50 MB body through a free Render instance, with a body-parser limit to raise, a slow mobile uplink doubling the trip, and a memory spike. Rejected. |
| **Browser → R2, then the portal streams to the service** (multipart) | ⚠ **Fallback only.** It costs an extra hop (R2 → portal → service) and the portal's bandwidth. Kept as a documented fallback if a reference fetch times out. |
| **Service fetches from R2 by presigned GET** | ✅ **Recommended** for the R2 → service leg. The service pulls directly from R2; the bytes cross the wire once. |

**So: browser → R2 (presigned PUT), service ← R2 (presigned GET, 10 minutes).**
The portal is the only component that holds both credentials, and it never
carries the file bytes.

### 7.8 How the Excel download keeps working after the service forgets the job

**The service's state is disposable; a saved snapshot is the permanent record.**
So the answer is: **the portal freezes the artifact at save time.**

```
Service still alive          Portal                    R2
──────────────────          ──────                    ───
GET /jobs/{id}/boq.xlsx  ──▶ received
                            written ────────────────▶ exports/.../boq-<id>-rev-1.xlsx
                            BoqSnapshot row points at it
Service forgets the job     (nothing to do)
                            GET /api/.../export
                            reads the blob path from the row
                            mints a 10-min presigned GET ──▶ browser downloads
```

**Three layers of protection, in order:**

1. **Store the service's own `.xlsx` at save time.** This is the exact file
   the user reviewed. It is never re-fetched, because the service regenerates
   the workbook from the *current* view — a re-fetch would silently produce a
   different file and make the audit trail fiction.
2. **Regenerate from the stored snapshot JSON** if the R2 export is missing.
   `exceljs` is **already a backend dependency** (`backend/package.json`), so
   this needs no new dependency. The regenerated file is written to a
   **different key** (`rev-{n}-regenerated.xlsx`) and its name says so. It is
   functionally equivalent but not byte-identical to the service's workbook, so
   the difference is stated rather than hidden.
3. **The snapshot JSON itself never expires.** Even if both the export blob and
   the service are gone, the BOQ is reconstructible from
   `snapshots/.../rev-{n}.json`.

**Recommendation: yes, store the `.xlsx` in R2 at approve-and-save time** — the
same moment the user acknowledges the SAMPLE notice. That acknowledgement is
recorded on the `BoqSnapshot` row (`acknowledgedById`, `acknowledgedAt`).

### 7.9 Every manual step in the Cloudflare dashboard

1. **Create the bucket.** Dashboard → Storage & Databases → R2 → **Create
   bucket**.
   - Name: `boq-generator`
   - Location: **Automatic** (same as the account's other buckets)
   - **Storage class**: Standard
   - **Public access**: leave **disabled** (no `r2.dev` subdomain, no custom
     domain)
   - Do **not** add a custom domain.
2. **Create the bucket-scoped API token.**
   R2 → **Manage R2 API Tokens** → **Create API Token** → **Object Read & Write**
   → Scope: **Specific bucket → `boq-generator`** → **Create**.
   - Copy the **Access Key ID** and the **Secret Access Key**. The secret is
     shown **once**.
   - **Do not** choose "Admin" — that would let the runtime create and delete
     buckets and rewrite CORS.
3. **Apply the CORS policy.** Either
   - run the sanctioned script with an **admin-capable** credential:
     `node backend/scripts/provisionR2.js --bucket boq-generator --origins https://acschennai.com,https://acs-portal-spa.onrender.com`
     (add the bucket to `ALLOWED_R2_BUCKETS` first so it is picked up by
     default), or
   - paste the rule into the dashboard's **Settings → CORS**:
     `AllowedOrigins: https://acschennai.com, https://acs-portal-spa.onrender.com` ·
     `AllowedMethods: PUT, GET, HEAD` · `AllowedHeaders: *` ·
     `ExposeHeaders: ETag` · `MaxAgeSeconds: 300`.
4. **Add the lifecycle rules.** Bucket → **Settings → Object lifecycle** →
   **Add rule**:
   - Rule 1 — Prefix `drawings/`, **Delete objects after 30 days**
   - Rule 2 — Prefix `exports/`, **Delete objects after 365 days**
   - Rule 3 — Prefix `snapshots/`, **no expiry** (or 3 years if your policy
     requires a maximum retention)
5. **Note the bucket host** for the service allowlist:
   `boq-generator.{ACCOUNT_ID}.r2.cloudflarestorage.com`
   (visible on the bucket's Overview page).
6. **Add the bucket to the portal's CORS provisioning list** — one line in
   `backend/src/lib/blobStorage.js`:
   `process.env.BUCKET_BOQ_GENERATOR || 'boq-generator'` in `ALLOWED_R2_BUCKETS`.
   **Not** in `REQUIRED_BUCKETS`: the new token is scoped to object access only
   and has no bucket-list permission, so a `HeadBucket` probe would 403 and
   fail `/ready` spuriously. The BOQ routes instead return a clear
   `503 BOQ_STORAGE_NOT_CONFIGURED` when the env vars are absent.
7. **Do not** add the bucket to the nightly DB backup (that backs up Postgres,
   not R2) and do not expect the R2 export to be covered by it — see §11.

---

## 8. Security

### 8.1 Authorization on every route

| Route | Rule |
|---|---|
| All `/api/boq-generator/*` | `requireAuth` (JWT), **plus** a new `requireBoqProjectAccess` middleware. |
| `requireBoqProjectAccess` | The employee must have an active **`ProjectAssignment`** row for `:projectId`. Admins bypass. This is the same rule the S7/ISRO-LEAK fix settled on for `?scope=assigned` — history-based discovery is **not** authorisation. |
| Job-scoped routes (`/jobs/:boqJobId/**`) | Load the `BoqJob` row **first**; then require `job.employeeId === req.employeeId \|\| req.isAdmin`. **Never** look up by `serviceJobId` alone — a job id is guessable and the service's ids are not secret. |
| Snapshot routes (`/snapshots/:boqSnapshotId`) | Resolve `boqSnapshot → boqJob → employeeId` and apply the same rule. A snapshot is never authorised on its own. |
| Upload / draft routes | Same rule, via the job the draft belongs to. A draft row is owned by the employee who created it. |
| Admin routes (`/api/admin/boq-generator/**`) | `requireAdmin` **and** `requireFreshAdmin` (the portal's re-auth check) — the same pair `/api/admin/payslips` uses. |
| The pilot gate | If `BOQ_PILOT_EMPLOYEE_IDS` is set, the nav entry and every route are additionally gated; the "not in pilot" page is returned **before** any project or job lookup, so a non-pilot employee cannot even confirm that a job id exists. |

### 8.2 The IDOR tests that must exist before this ships

Every row is a test, not a hope. The job/snapshot ids are sequential-ish and
guessable, so "the id is unguessable" is not a defence.

| # | Attack | Expected |
|---|---|---|
| 1 | Employee B reads employee A's job by portal id (`GET /api/boq-generator/jobs/:id`) | **404** (not 403 — do not confirm the id exists) |
| 2 | Employee B reads employee A's **snapshot** by id | **404** |
| 3 | Employee B reads employee A's **service** job through the portal (`?serviceJobId=`) | **404** — and the route does not accept a service id as an address |
| 4 | Employee B downloads employee A's **export** blob | **404** — the blob path is resolved from the snapshot row, never accepted from the client |
| 5 | Employee B posts a **correction** to employee A's job | **404** |
| 6 | Employee (not admin) calls an admin route | **403** |
| 7 | Employee with **no assignment** to project X reads X's drawings or starts a job on X | **403** `NOT_ASSIGNED_TO_PROJECT` |
| 8 | Employee **formerly** assigned to X (assignment ended) reads X's job | **403** — the rule is a live `ProjectAssignment` row, not history |
| 9 | Employee passes a **presigned URL from another employee's upload** into the job-create body | **400** — the route takes an `uploadId`, never a URL |
| 10 | Employee passes an `uploadId` belonging to another employee | **404** — the upload intent is resolved by `id + employeeId` |
| 11 | Employee passes a **blob path** (`drawings/…`) in the body | **400** `UNKNOWN_FIELD` — the route has a strict body schema |
| 12 | Any caller reads a `boq_job` or `boq_snapshot` row **directly through PostgREST / Supabase** | **no rows** — RLS deny-all for `anon` and `authenticated` (§6) |

### 8.3 Validation of file references

The rule is simple and it is the whole defence:

> **The client sends identifiers. The server resolves them. The client never
> sends a URL, a bucket name, a key or a path.**

| Field the client may send | What the server does with it |
|---|---|
| `uploadId` (the portal's ULID) | Looks up the `UploadIntent`/upload row **scoped to the employee**, reads the stored `blobPath`, mints the presigned GET itself |
| `drawingId` | Same — resolved inside the employee's own upload rows |
| `projectId` | Checked against `ProjectAssignment` before anything else |
| `contentType` | **Ignored for trust purposes.** The declared type must be in the allow-list (`application/dxf`, `application/vnd.autodesk.dxf`, `model/ifc`, `application/x-step`, `text/plain` for ASCII DXF) **and** the bytes must pass the magic-byte check |
| `filename` | Sanitised for display only; **never** used to build a storage key and **never** used to decide the file type |

**Filename sanitisation** (for the display name and the R2 key suffix):

1. Take the basename only (strip any path).
2. Strip control characters and anything outside `[A-Za-z0-9._ -]`.
3. Cap at 120 characters.
4. The stored R2 key uses a **generated ULID**, never the filename:
   `drawings/{projectId}/{employeeId}/{ulid}.{ext}` — so a filename can never
   escape its prefix or collide.

**Magic-byte verification — a gap that must be closed for this path.** The
service sniffs the bytes itself (`app/api/storage.py`: `%PDF-` → refused,
`AutoCAD Binary DXF` → dxf, `ISO-10303-21` → ifc, ASCII `0`/`SECTION` → dxf),
but it does that **after** the job is created, so the user has already waited
through the upload. There is **no `verifyBlobMagicBytes` in the portal's
`blobStorage.js` today**. The BOQ upload path adds one (a new exported
function — additive, nothing existing changes):

1. After the browser's PUT, `confirm-upload` runs a ranged `GetObject`
   (first 16 bytes) and a `HeadObject` (length, content type).
2. The bytes must match the declared family. A file declared DXF whose bytes
   are `%PDF-` is **rejected at upload** with
   "This file is a PDF. We can measure IFC and DXF files only."
3. A **mismatch between the declared content type and the sniffed type** is a
   hard failure, not a warning.
4. The extension in the key is derived from the **sniffed** type, never from
   the client's filename.

### 8.4 Presign scope and expiry

| Presign | Method | TTL | Bound to |
|---|---|---|---|
| Upload (browser → R2) | **PUT only** | **900 s** (the existing `generateUploadSASUrl` default) | The exact key `drawings/{projectId}/{employeeId}/{ulid}.{ext}` and the exact `ContentType` |
| Service fetch (R2 → BOQ service) | **GET only** | **600 s** (10 minutes, the maximum you allowed) | The exact key of one uploaded drawing |
| Browser download (R2 → browser) | **GET only** | **600 s** | The exact export or snapshot key of a job the caller owns |
| Portal → service API calls | n/a | n/a | Bearer token, server-to-server, never presigned |

**Rules**

- The service-fetch presigned URL is minted **inside the `POST /jobs` handler
  and handed straight to the service**. It is never returned to the browser,
  never stored in the database, and never logged.
- Because the service fetches **synchronously inside the POST**
  (`app/api/app.py:916-919`), a 600 s URL is comfortably safe.
- The upload presign and the service-fetch presign are **different objects**
  with different TTLs; the service never receives the 15-minute upload URL.
- **No presigned URL is ever a query parameter.** `requestLogger` logs
  `req.originalUrl` including the query string, so a URL in a query would be
  written to `AppLog` in plain text. That is the single most likely way this
  feature leaks a signature, and it is why the API takes ids, not URLs.

### 8.5 Token handling

| Secret | Where it lives | Where it must never appear |
|---|---|---|
| `BOQ_API_TOKEN` (the service's bearer token) | The **portal backend's** Render env var | The frontend bundle, any response body, any log line, `VITE_*`, the repo |
| `R2_BOQ_ACCOUNT_ID` / `R2_BOQ_ACCESS_KEY_ID` / `R2_BOQ_SECRET_ACCESS_KEY` | The portal backend's Render env var | The frontend bundle, any log line, any response body |
| The service's URL | The portal backend's Render env var (`BOQ_BASE_URL`) | Nowhere sensitive, but the portal frontend calls only its own API |

- The service client lives at **`backend/src/lib/boqClient.js`** (§2.2 D2),
  uses the **built-in `fetch`** (Node 18+ — no new dependency, no axios).
- The token is attached **only** in that module. There is no code path that
  puts it in a URL, a query string or a body.
- The service has **no CORS** and is designed server-to-server. The browser
  never talks to it.
- Per-user identity reaches the service through the `requested_by` field, which
  the portal sets to a portal-generated run id (`boqjob:{portalJobId}`). The
  portal's own `boq_job.employeeId` is the real owner of the record; the
  service's `requested_by` is a correlation handle, not an authorisation.
- **Rotation** is a Render env var change + a restart. It is a two-minute job
  and does not need a code change.
- A test asserts the **built frontend bundle** contains neither the token nor
  the string `BOQ_API_TOKEN` (§9.3).

### 8.6 Rate limits

The portal is the **only** caller of the service, so the service's limits are
effectively **portal-wide**. The service has two limiters
(`app/api/app.py:605-606`): a **per-token** one at
`api_rate_limit_per_minute = 240` (one bucket per bearer token — every
employee shares the portal's token, so it is one bucket for the whole
portal), and a separate **per-IP** one that is currently **disabled**
(limit `0`). The portal's own limits are the real control.

| Limiter | Limit | Applies to |
|---|---|---|
| `sasLimiter` (existing, 60/min) | reuse | the upload presign route |
| `boqUploadLimiter` (new) | 30/hour per employee | uploads + presigns |
| `boqJobLimiter` (new) | **10 jobs/hour per employee**, and **5 concurrent open jobs portal-wide** | job creation |
| `boqWriteLimiter` (new) | 60/min per employee | corrections, saves, exports |

**Why the concurrency cap matters.** The service's worker handles **one job
per cycle** and polls every second, so a queue of 5 DXF jobs is already a
multi-minute wait. The portal refuses a 6th concurrent job with
*"Five drawings jobs are already running. Wait for one to finish and try
again."* rather than silently queueing a sixth.

**Polling budget.** With the backoff in §5 (3 s → 5 s → 10 s, capped), one
polling job costs at most 20 requests/minute. Five concurrent jobs = 100/min,
leaving headroom under the service's 240/min even if the per-IP limit is
switched on.

### 8.7 Logging rules

The portal's `redact()` only hashes keys matching
`/email|phone|address|ssn|pan|aadhaar/i` — it does **not** redact URLs. So
these rules are explicit rather than inherited:

| Never logged | Why |
|---|---|
| A presigned URL (upload, service-fetch or download) | The signature is a bearer credential for that object |
| The service bearer token | Obvious |
| The BOQ body (line items, quantities, rates) | Commercially sensitive; it lives in the snapshot, not in the log |
| A file's bytes | n/a |
| The client's IP | The portal's error handler does not capture it today; keep it that way |

**Logged instead:** `requestId`, `employeeHash` (HMAC via `PII_LOG_SALT`),
`projectId`, `boqJobId`, `boqSnapshotId`, the action, the counts
(`lines`, `withheld`, `priced`), the service's `error.code`, the latency, and
the status. Every write goes through `lib/log.js` → `AppLog`.

A **regression test** asserts that a presigned URL never reaches the
`AppLog` table — it is the kind of bug that is invisible until somebody greps
the database.

### 8.8 The service's own posture (what it already does for us)

- **Bearer-token auth** on every route (`require_auth`).
- **No CORS** — it cannot be called from a browser, which is what we want.
- **Fetch hardening**: HTTPS only, **no redirects followed**, an
  allow-list of hosts (`BOQ_API_FETCH_ALLOWED_HOSTS`), a 5 s connect timeout,
  a 60 s total fetch timeout, a 100 MB fetch cap, and SHA-256/size
  verification when the caller supplies them.
- **Refuses PDFs by content**, not by extension (`%PDF-` → `PDF_NOT_SUPPORTED`).
- **`api_max_sources = 20`** files per job.

**One manual item falls out of this:** the service's host allow-list must
include the R2 host, or every fetch is refused with `FETCH_HOST_REFUSED`. See
§11.3, item 4.

### 8.9 The security checklist to run before the pilot

- [ ] Every route in §8.1 has its middleware, and the IDOR tests in §8.2 pass.
- [ ] No presigned URL in `AppLog`, in the error messages, or in the query string.
- [ ] The built frontend bundle contains no service token and no R2 secret.
- [ ] The magic-byte check rejects a mislabelled file **at upload**.
- [ ] The upload key contains the employee id and the generated ULID — no filename.
- [ ] The scale is never auto-filled from `scale_suggestion`.
- [ ] The SAMPLE banner is present on the screen, in the filename, in the
      workbook header **and** footer, and behind an export acknowledgement.
- [ ] A saved snapshot cannot be edited or deleted through any route.
- [ ] `boq_job` and `boq_snapshot` are deny-all under RLS for `anon` and
      `authenticated`.
- [ ] The pilot gate is on, and a non-pilot employee gets the "not available
      to your account" page rather than a 404.

---

## 9. Testing and verification

### 9.1 A fake of the BOQ service — no new dependencies

**Where:** `backend/__tests__/fixtures/boqServiceFake.js`.

**Shape:** a plain factory that returns canned responses — the same idea as
`makeS3Mock` in `backend/__tests__/storage.test.js:50-80`, and the same
injection style as `backend/__tests__/payslip-upload-intent-prefix.test.js:61-80`:

```js
// backend/__tests__/fixtures/boqServiceFake.js
// No dependency. A plain object of handlers + a tiny in-memory job store.
export function makeBoqServiceFake(overrides = {}) {
  const state = { jobs: new Map(), seq: 0 };
  return {
    state,
    handlers: {
      'GET /health': async () => ({ status: 'ok' }),
      'GET /meta': async () => META_FIXTURE,
      'POST /jobs': async (req) => { /* 202, { job_id, status: 'queued' } */ },
      'GET /jobs/{id}': async (req) => { /* queued → running → done */ },
      'GET /jobs/{id}/boq': async (req) => BOQ_FIXTURE,
      'GET /jobs/{id}/snapshot': async (req) => SNAPSHOT_FIXTURE,
      'PATCH /jobs/{id}/lines/{lineId}': async (req) => CORRECTED_BOQ_FIXTURE,
      'GET /jobs/{id}/boq.xlsx': async (req) => XLSX_FIXTURE,
      'DELETE /jobs/{id}': async (req) => ({ ok: true }),
    },
    ...overrides,
  };
}
```

It is injected either by `jest.mock('../src/lib/boqClient')` (unit tier) or
through the existing `createApp({ prisma, blobStorage })` seam
(`backend/src/index.js:94-107`) for the whole-app tier.

**The fake must reproduce the awkward parts — that is the entire point of it:**

| The fake must do | Because |
|---|---|
| Return `202` with a job id, then flip `queued → running → done` over a few polls | The real service is asynchronous; a synchronous fake would not test the waiting screen |
| Honour `JOB_NOT_READY` when `/boq` is called too early | That is a real 409 the portal must map |
| Fail with `JOB_INTERRUPTED` and `retryable: true` when told to | The service's restart behaviour is the most common real failure |
| Fail with `SOURCE_UNCALIBRATED` when `dxf_scale` is absent | The scale gate must be tested at the portal boundary |
| Fail with `PDF_NOT_SUPPORTED` and `UNSUPPORTED_FILE_TYPE` | The two file errors the user will actually hit |
| Fail with `UPLOAD_TOO_LARGE` above 100 MB | The service's cap, not the portal's |
| Fail with `RATE_LIMITED` and `IDEMPOTENCY_CONFLICT` | Both are real service codes |
| Fail with `CORRECTION_REFUSED` on a wrong-state correction | The service's `INVALID_STATE` is dead code; `CORRECTION_REFUSED` is the live one |
| Return `data_status: "SAMPLE"`, `used_sample_rates: true` | The banner must appear in every test |
| Return `scale.suggested: 1` | The fake must reproduce the meaningless suggestion so the test proves it is not shown |
| Return `level: ""` on one line and `UNKNOWN_STOREY` on another | The "Level not stated" path |
| Return `withheld_count`, `withheld_by_reason`, `withheld[]` and a line with `BBOX_FALLBACK` | The "kept out of the total" card |
| Return `corrections[]` with `old_value`/`new_value`/`reason`/`requested_by`/`created_at` | The change log |
| Return `materials[]` and `derivations[]` | The derived-quantities panel |

**The fixtures are copied from the real service's own shapes** — the JSON in
`docs/RESULT-SNAPSHOT.md` and the `/boq` body from `app/api/views.py` — so
the fake cannot drift into a shape the service never produces.

### 9.2 Contract tests that can also run against the real service

**Why a separate script:** the fake proves the portal behaves; it cannot
prove the *service* still behaves. The drift risk is real — the service is a
separate repo on a different release cycle.

**`backend/scripts/boq-contract-check.js`** — Node, **no dependencies**
(the backend already has `fetch`; nothing to install):

1. Read `BOQ_BASE_URL` and `BOQ_API_TOKEN` from the environment.
2. Run the sequence: `/health` → `/meta` → `POST /jobs` (one tiny DXF
   fixture) → poll `/jobs/{id}` → `/boq` → `/snapshot` → `PATCH` one line →
   `/boq.xlsx` → `DELETE /jobs/{id}`.
3. Assert the **shape** of every response against
   `backend/__tests__/fixtures/boqContract.json` — field names, types,
   required keys, the `error.code` vocabulary. **Not** the values, which
   change with the data.
4. Print a diff and exit non-zero on any mismatch.

**It is not in CI** — there is no token in CI, and the service is a free-tier
Render instance with a ~60 s cold start. It is run **by hand** when the
service is redeployed, and its output is pasted into
`verification/<date>-boq-contract/`.

**Drift detection without the network:** the contract file is **generated
from the fake**, so `npm test` fails the moment someone changes the fake
without regenerating it. And a **second script** compares the live response
against the contract file — so a service change that the portal has not
absorbed shows up as a red diff rather than as a production error.

> The service's own repo already has `scripts/smoke_test.py`. This is the
> Node equivalent, because the portal's runtime is Node — the portal cannot
> run a Python script, and the portal's CI cannot depend on a Python runtime.

### 9.3 Backend and frontend tests

**Rules that apply to every test file (project conventions):**
- Backend: Jest, under `backend/__tests__/`, run with
  **`node node_modules/.bin/jest`** — **never `npx jest`** (project rule).
- `.skip(` is forbidden in `__tests__/integration/` and allowed in the unit
  tier only if listed in `backend/__tests__/SKIPPED_TESTS.md`.
  `.only(` is forbidden everywhere.
- Frontend: Jest + jsdom under `src/__tests__/*.test.jsx`, with
  `AuthContext` and `ToastContext` mocked and `MemoryRouter` used.
- **No new dependency.** No Supertest additions (it is already there), no
  nock, no msw.

| File | What it proves |
|---|---|
| `backend/__tests__/boqGenerator.auth.test.js` | The 12 IDOR cases in §8.2, one `test.each` row each. **This is the file that must not be softened.** |
| `backend/__tests__/boqGenerator.routes.test.js` | The happy path: create → poll → review → correct → save → download, against the fake. |
| `backend/__tests__/boqGenerator.errors.test.js` | A table-driven test: every service `error.code` in §1.7 maps to the right portal code and the right user-facing copy. A new service code with no mapping **fails the test**. |
| `backend/__tests__/boqGenerator.upload.test.js` | The presign is PUT-only, 900 s, under `drawings/{projectId}/{employeeId}/{ulid}.{ext}`; the content-type allow-list rejects PDF; the size cap rejects > 100 MB; `confirm-upload` runs the magic-byte check and rejects a PDF declared as DXF; the key contains no part of the client's filename. |
| `backend/__tests__/boqGenerator.scale.test.js` | A DXF with no scale never reaches the service; two drawings at different scales produce **two** service jobs and one portal run; `scale.suggested` is never sent to the browser. |
| `backend/__tests__/boqGenerator.snapshot.test.js` | The snapshot row is immutable — a second revision creates a **new** row and leaves the first untouched; `data_status: "SAMPLE"` gives the SAMPLE banner; `data_status: "REAL"` **with** `production_mode: false` still gives the DRAFT/SAMPLE banner (the `effectiveStatus` rule); an unknown `schema_version` is refused with a clear message. |
| `backend/__tests__/boqGenerator.export.test.js` | The regenerated workbook carries the banner in the header **and** the footer, the filename carries the status, the export is blocked without the acknowledgement, and the acknowledgement is stored with who and when. |
| `backend/__tests__/boqGenerator.idempotency.test.js` | The same `Idempotency-Key` + the same body replays the first response; the same key + a different body returns `409 IDEMPOTENCY_MISMATCH`. (The durable `request_dedupe` table already does this — this test proves the BOQ routes use it.) |
| `backend/__tests__/boqGenerator.nosecret.test.js` | The built frontend bundle contains neither the service token nor `BOQ_API_TOKEN`; and a presigned URL never appears in an `AppLog` row. |
| `src/__tests__/BoqGenerator.behavior.test.jsx` | The banner renders whenever `effectiveStatus !== 'REAL'`; **the total never renders without the banner**; the export button stays disabled until the acknowledgement is ticked; the correction drawer blocks a save with no reason; the empty state, the failure state and the mobile card list all render. |
| `src/__tests__/BoqGenerator.a11y.test.jsx` | `jest-axe` (already a dev dependency) on the review screen and the drawer. |

### 9.4 Running against the service in development

- `BOQ_BASE_URL` points at the service. For local development against the
  service's own dev server, `http://127.0.0.1:8000` (the README's default) or
  `http://127.0.0.1:10000` (the Docker port — the README says 8000 and the
  Dockerfile says 10000; that discrepancy is in the service's own docs).
- `BOQ_MOCK=1` makes the backend serve the fake's responses **in-process** —
  no network at all. This is how the frontend is built without the service
  being up, and how the CI screenshot tests run.
- The fake is the **same module** the tests use, so "works against the fake"
  and "works in CI" cannot diverge.

### 9.5 Browser verification (desktop and mobile), with screenshots

The tooling here is the `enduser_tester` MCP server (Playwright-based:
`browser_navigate`, `browser_screenshot`, `browser_a11y`, `browser_resize`).

**Rule for production:** **navigate only.** No form submission, no upload, no
correction, no save, no download on any production instance. The
production pass is a read-only smoke: the nav entry is present for a pilot
user, the SAMPLE banner is visible, the empty state renders, and no console
error appears.

**The full flow runs against local dev with the mock service.**

| # | State | Viewport | Screenshot |
|---|---|---|---|
| 1 | Empty — no project | 1440×900 and 390×844 | `01-empty-{desktop,mobile}.png` |
| 2 | Choosing drawings | both | `02-choose-{…}.png` |
| 3 | Uploading | both | `03-uploading-{…}.png` |
| 4 | Settings / calibration | both | `04-settings-{…}.png` |
| 5 | Waiting — service waking | both | `05-waiting-{…}.png` |
| 6 | Review — SAMPLE banner + total | both | `06-review-{…}.png` |
| 7 | Review — a flagged line open | both | `07-line-detail-{…}.png` |
| 8 | "What this number covers" | both | `08-coverage-{…}.png` |
| 9 | Saved | both | `09-saved-{…}.png` |
| 10 | Failed / interrupted | both | `10-failed-{…}.png` |
| 11 | The export acknowledgement | desktop | `11-export-gate.png` |

Plus, at each viewport: a console-error check and an `browser_a11y` pass.
Screenshots go to `verification/<date>-boq-generator/`, committed as evidence
in the usual way.

### 9.6 What "done" means for this feature

- All of §9.3 passes, with **no skipped tests**.
- The 12 IDOR cases pass.
- The 11 browser states are screenshotted at both viewports with no console
  error and no accessibility violation.
- The contract check has been run against the live service **once**, and the
  output is filed in `verification/`.
- The manual steps in §11.3 are complete **before** the pilot opens.

---

## 10. Implementation phases — small commits, in order

**Effort is in working days for one engineer, and assumes no new dependency.**

| Phase | Commit(s) | What is in it | Days | Ships |
|---|---|---|---|---|
| **0 — Manual setup** | *(not a commit)* | The Cloudflare bucket + token, the Render env vars, the service's host allow-list, the pilot list (§11.3) | **0.5 (you)** | nothing — but blocks Phase 3 |
| **1 — Schema** | 1. `feat(boq): add boq_job and boq_snapshot models` <br> 2. `feat(boq): add the RLS lockdown migration` | The two additive Prisma models, the migration, the deny-all RLS migration with the verification block, and the model tests | **1** | nothing user-facing |
| **2 — R2 bucket + upload** | 3. `feat(boq): add the boq-generator bucket to the R2 helper` <br> 4. `feat(boq): add the drawing upload route with magic-byte verification` | The bucket constant, the presign route, the confirm route, `verifyBlobMagicBytes`, the size/type caps, the prefix test | **1.5** | a file can be uploaded |
| **3 — Service client + job lifecycle** | 5. `feat(boq): add the BOQ service client` <br> 6. `feat(boq): add the job create, poll and status routes` | `backend/src/lib/boqClient.js`, the create/status routes, the backoff poller, the idempotency key, the error mapping | **2** | a job can be started and watched |
| **4 — Snapshot + review data** | 7. `feat(boq): capture and store the snapshot at done` <br> 8. `feat(boq): add the correction route and the change log` <br> 9. `feat(boq): add the reconcile cron` | The snapshot capture, the `BoqSnapshot` write, the correction proxy, the change log, the daily reconcile for orphans | **2** | the BOQ is durable and correctable |
| **5 — Export + coverage** | 10. `feat(boq): generate the export workbook from the snapshot` <br> 11. `feat(boq): add the export acknowledgement gate` | The `exceljs` workbook with the banner in the header and footer, the SAMPLE filename, the coverage card data, the acknowledgement record | **2** | a safe download |
| **6 — The page** | 12. `feat(boq): add the BOQ Generator page` <br> 13. `feat(boq): add the Tools nav group and the route` <br> 14. `feat(boq): mobile layout and the pilot gate` | The React page, all the states, the nav group under "My Reports", the route, the mobile card list, the pilot gate | **3** | **the feature** |
| **7 — Verification** | 15. `docs: file the BOQ Generator verification evidence` | The screenshots, the contract-check output, the test evidence | **0.5** | sign-off |
| | | **Total** | **≈ 14.5** | |

**What can ship first, and in what order of value:**

1. **After Phase 3 (≈ 4.5 days):** the job runs and the user sees the waiting
   screen and the outcome. Useful for proving the pipeline; not yet a BOQ.
2. **After Phase 5 (≈ 8.5 days):** the backend can produce a durable,
   correctable, safely-exportable BOQ. **This is the first point at which the
   feature has real value**, and it can be verified without the frontend.
3. **After Phase 6 (≈ 12.5 days):** the whole thing is usable by an employee.

**Two scope levers, if the estimate needs to come down:**

- **Drop Phase 7's browser verification to one viewport** — saves 0.25 day,
  costs real confidence. Not recommended.
- **Drop the mobile layout (part of commit 14)** — saves ~0.5 day and breaks
  your "mobile friendly" requirement. Not recommended.
- **The one genuinely optional piece is the reconcile cron (commit 9, ~0.25
  day)** — without it, a portal DB restored from an old backup can show jobs
  whose service state is gone; the user sees "the drawing service forgot this
  job" and can re-run. Cheap insurance; keep it.

**Every commit in this plan is independent and reviewable, and each one keeps
the suite green** (`node node_modules/.bin/jest`). Nothing here modifies
`BoqItem` or `/api/boq`.

---

## 11. Risks, open questions, and what you must do by hand

### 11.1 Risks

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| 1 | **A wrong scale factor (100× or 1000×) across the whole take-off.** The BOQ still looks plausible — right items, right groups, sane quantities, wrong by a factor. | High — this is the QS's #1 fear and the code confirms the arithmetic (`units_per_m = unit × scale`) | **Severe.** One number, silently wrong across every line. | The permanent multiplier warning; the recorded known-dimension note; the coverage card; the "not the project cost" line. **Not fully mitigated in v1** — there is no automated verification. **This is the top residual risk of the feature.** |
| 2 | The service is on a **free Render instance** — cold start ~60 s, restarts without warning. | Certain | Medium | The portal's outbound timeout is 180 s; the waiting screen explains it; a restart mid-job is reported as "the service restarted", with `retryable: true` and a one-click re-run. |
| 3 | The service's state is **disposable** — the job can be gone before the user saves it. | High | Medium | The portal captures the snapshot the moment the job reaches `done`; the snapshot is the record; the export is stored in R2 at save time (§7.8). |
| 4 | The service's **240 req/min** limit, with every portal call coming from one IP. | Low | Medium | Polling backoff (3 → 5 → 10 s); the 5-concurrent-jobs cap; the service's per-IP limit is currently disabled. |
| 5 | The service's `scale_suggestion` is **`1`**, from a synthetic sample map that disclaims any relation to ACS drawings. | Certain | High if shown | The portal never shows it. If a real ACS layer map lands, it becomes an "unverified" hint — never an auto-fill. |
| 6 | **Sample rates escape to a client.** The QS named this as the abandonment trigger. | Low, if the gates hold | **Severe for the business** | The banner in five places; the SAMPLE filename; the export acknowledgement; the exclusions card; the pilot gate. |
| 7 | The service and the portal **disagree on the snapshot schema**. | Low | Medium | The portal refuses an unknown `schema_version` with a clear message instead of guessing, and the contract check (§9.2) catches it before a user does. |
| 8 | The portal's `boq_job` table gets **ahead of reality** (a DB restore, a lost service). | Low | Low | The reconcile cron marks orphans as "the service forgot this job" and offers a re-run. |
| 9 | `withheld_count` is **large** (46 of 260 lines) and looks like a bug. | Certain | Low | The coverage card turns it into information: "82% priced, and here is what is missing and why". |
| 10 | The service has **no list-jobs endpoint**, so the portal's table is the only index. | Certain | Low | Accepted by design; documented in §6. |
| 11 | A **second R2 bucket + token** is more operational surface than reusing `dpr-documents`. | Certain | Low | Your brief requires it; the bucket-scoped token is the safer of the two, and it is one more entry in the Cloudflare dashboard. |
| 12 | The free service processes **one job per cycle** — a queue of five DXFs takes minutes. | High | Low | The waiting screen, the concurrency cap, and the "you can close this page" copy. |
| 13 | **Nobody verifies the BOQ against a drawing.** The portal cannot: it has no DXF parser. | Certain | High (in the real world) | This is a process control, not a code control: the coverage card, the calibration note, and — if you want it — a rule that a BOQ cannot be exported until someone ticks "I have checked the quantities against the drawings". **Offered as a decision below.** |

### 11.2 Open questions

**For the service owner (they need a service change, not a portal change):**

1. **Per-file calibration.** Can the service accept a per-file drawing unit and
   a measured dimension, and echo the calibration back in the snapshot? Today
   it accepts one denominator per job, reads the unit from `$INSUNITS`, and
   exposes no unit. **Default if unanswered:** keep the current model, with
   the multiplier warning (D10).
2. **Inserting a line.** Is there a way to add an item the model does not
   contain (doors, sanitary, painting)? Today `PATCH` only edits existing
   lines. **Default:** not in v1 (D14).
3. **Verifying a known dimension.** Could the service measure one named
   dimension and return it, so the portal can check the user's declared value?
   **Default:** record, do not verify (D10).
4. **Is there a real ACS layer map?** It decides whether `scale_suggestion`
   becomes useful at all, and it decides which layers are measured.
5. **Is the ACS Schedule of Rates available** — with an edition, a region and
   real rates? Until it is, this tool is a **take-off**, not a BOQ (D11).

**For you (the portal owner):**

6. **`BOQ_PILOT_EMPLOYEE_IDS`** — set it, or leave it open? **Recommendation:
   set it** to a short pilot list while the rates are sample (D8).
7. **Should the page also offer the existing project attachments**
   (`DocumentCategory.DESIGN_DRAWINGS`) as a source of drawings? **Default: no**
   for v1. It needs a second presign path (the existing bucket's credentials),
   an attachment-level authorisation check, and the drawing's own expiry; the
   v1 path — upload into the BOQ bucket — is simpler and self-contained.
8. **Should the export be blocked until a person ticks "I have checked the
   quantities against the drawings"?** **Default: no** — one gate is enough,
   and two gates is how tools get abandoned. The QS asked for it; you decide.

### 11.3 Exactly what you have to do by hand

| # | What | Where | When |
|---|---|---|---|
| 1 | **Create the R2 bucket** `boq-generator` — private, Automatic region, no public access, no custom domain. | Cloudflare dashboard | Before Phase 2 |
| 2 | **Create the R2 API token** — *Object Read & Write*, scoped to **the `boq-generator` bucket only**. Copy the Access Key ID and the Secret Access Key (shown once). | Cloudflare dashboard | Before Phase 2 |
| 3 | **Add five env vars** to the portal's Render service: `R2_BOQ_ACCOUNT_ID`, `R2_BOQ_ACCESS_KEY_ID`, `R2_BOQ_SECRET_ACCESS_KEY`, `BOQ_API_TOKEN`, `BOQ_BASE_URL`. | Render → the ACS Chennai portal service | Before Phase 3 |
| 4 | **Add the R2 host to the BOQ service's allow-list**: `BOQ_API_FETCH_ALLOWED_HOSTS` must include `*.r2.cloudflarestorage.com`, with `sync: false` (it is `sync: false` in the service's `render.yaml` today, so it is currently empty). **Without this every fetch fails with `FETCH_HOST_REFUSED`.** | Render → the **BOQ service** (`acs-boq-generator`) | Before Phase 3 |
| 5 | **Confirm the portal's deployment applies the migration** (`prisma migrate deploy` in the start command) — or run it yourself. The two new tables are additive; no data is rewritten. | Render / the DB | Before Phase 5 |
| 6 | **Decide the pilot list** and set `BOQ_PILOT_EMPLOYEE_IDS`. | Render | Before Phase 6 |
| 7 | **Set the CORS rule and the lifecycle rules** on the bucket (§7.9, steps 3 and 4) — or run the sanctioned `provisionR2.js` with an admin-capable credential. | Cloudflare dashboard | Before Phase 2 |
| 8 | **Decide who deploys the BOQ service.** Its `render.yaml` has `autoDeployTrigger: off`, so a service change needs a deliberate deploy. | Render | When the service is updated |

### 11.4 Five decisions I need from you

Each has a default that I will implement unless you say otherwise.

| # | Decision | My recommendation |
|---|---|---|
| 1 | Show the **sample total**, or hide all money until the rates are real? | **Show it**, walled off behind the banner, with the "Amount (sample rate)" column header and the export gate. |
| 2 | **Pilot only**, or open to everyone? | **Pilot only** while the rates are sample. |
| 3 | Page title: **"BOQ Generator"** or **"Quantity take-off"**? | Nav says **"BOQ Generator"**; the page title follows the data status (§2.2 D11). |
| 4 | Do the drawings get a **"1 — already in real millimetres"** preset? | **No preset.** The warning is enough, and a wrong preset is worse than no preset. |
| 5 | Reuse **existing project attachments** as drawing sources in v1? | **No** — v1 uploads into the BOQ bucket only (§11.2, question 7). |

### 11.5 What I will not do without asking

- Add any npm dependency (`exceljs` is already there, so nothing is needed).
- Touch `BoqItem`, `/api/boq`, or the existing `dpr-documents` bucket.
- Change the service repository in any way — the plan treats it as read-only.
- Deploy anything, create any bucket or token, or change any Render or
  GitHub resource.
- Open the pilot to more than the list you name.

---

*End of plan. Nothing in this document has been implemented — no file outside
this plan was created or changed.*