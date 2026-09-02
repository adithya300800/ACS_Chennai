# Tenancy — ACS Chennai Portal

> Single-tenant boundary declaration. Read this before adding any field that
> scopes by organization/project. The portal is intentionally built for **one
> organization only** — every query, storage path, OAuth admission rule,
> audit event, and admin predicate assumes that boundary.

**Owner:** platform engineering
**Last reviewed:** 2026-09-02 (round-20, DR-019)
**Status:** ACTIVE single-tenant deployment

---

## 1. Current Scope

The portal is the **internal employee portal for ACS Chennai** — a single
construction-services organization. It is not a multi-tenant SaaS. The
runtime assumptions, the deployment topology, and the data model all
encode that single-organization scope.

| Boundary dimension | Current value |
|---|---|
| Operating organization | **ACS Chennai** |
| Allowed email domains | `acschennai.com` (see §3) |
| Deployment target | Render (`acs-chennai.onrender.com`) |
| Data plane | Supabase PostgreSQL (single DB, no logical partitioning by org) |
| Object storage | Cloudflare R2 (single account, three buckets) |
| Public web origin | `https://acschennai.com` (GitHub Pages) |
| Frontend build cache | GitHub Pages artefact per push |

Any change to the schema, OAuth allowlist, CORS list, or admin role check
that **introduces** a second organization is out of scope for normal
feature work. It is a tenancy refactor and MUST follow the checklist in
§6.

---

## 2. What Is a Tenant Boundary

A *tenant boundary* is any field that, if violated, lets one organization's
employees see, mutate, or be authenticated as another organization's
employees. In the current build there are exactly three:

| Boundary | Where | What it gates |
|---|---|---|
| `Employee.email` domain match | `backend/src/routes/auth.js` (`ALLOWED_EMAIL_DOMAINS`, used in the OAuth callback in both `GET /api/auth/zoho/callback` and `POST /api/auth/zoho/callback`) | OAuth self-provisioning — a non-allowlisted domain is rejected before an Employee row is ever written |
| `Employee.isAdmin` flag | `backend/src/lib/revocation.js`, all `requireAuth`/`requireAdmin` consumers, the `/api/auth/refresh` token claim | Privileged write paths (DPR approve/reject, leave approve, training CRUD, bulk operations) |
| Login session | `Employee.id` (FK on every row), `requireAuth` JWT payload, `RefreshToken.employeeId` | Every read/write — there is no anonymous endpoint that touches business data |

Everything else is **reporting data** (see §3). Reporting data is allowed
to be free-text, duplicated, or wrong; tenant boundaries are not.

---

## 3. OAuth / Domain Admission

The admission boundary is the email-domain allowlist read at OAuth-callback
time, NOT a database lookup. Today:

```js
// backend/src/routes/auth.js
const ALLOWED_EMAIL_DOMAINS = (process.env.ALLOWED_EMAIL_DOMAINS
  ? process.env.ALLOWED_EMAIL_DOMAINS.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  : ['acschennai.com']
);
```

Defaults to `acschennai.com`; override via `ALLOWED_EMAIL_DOMAINS` env var
(comma-separated). Used in:

- `GET  /api/auth/zoho/callback` — popup-flow callback. Returns the
  `domain_not_allowed` error page if the email's domain is not in the
  allowlist.
- `POST /api/auth/zoho/callback` — SPA-flow callback. Returns `403 Email
  domain not permitted`.

**This is the only place where an external principal becomes an internal
Employee row.** Password login (`POST /api/auth/login`) does NOT consult
the allowlist — it matches an existing row by email, which by definition
was admitted through the OAuth path. (Adding a new password-only user
without OAuth is a separate admin operation that creates the row directly
in the database; it's not a self-service admission path.)

**Future tenancy note:** when a second organization is onboarded (see
§6), this allowlist MUST move off the env var and onto a per-organization
allowlist looked up by `Organization.slug` from the JWT or the OAuth
domain hint.

---

## 4. What Is NOT a Tenant Boundary

These fields *look* like they might authorize data, but they don't. They
are reporting inputs — anyone can write them, anyone can see them, and
they have no authorization semantics.

| Field | Model | Why it is not a tenant boundary |
|---|---|---|
| `DPR.projectName` | DPR | Free-text from the submitter; not unique; not referenced by any auth check |
| `DPR.contractor` | DPR | Free-text; describes the site contractor, not the portal org |
| `DPR.location` | DPR | Free-text site location |
| `DPR.weather`, `DPR.temperature` | DPR | Reporting only |
| `DPR.workExecutedToday`, `manpowerSummary`, `risksHindrances`, `materialsReceivedSummary` | DPR | PMC daily-narrative fields — narrative, not authorization |
| `DPR.customSections` (Json) | DPR | User-added text/table blocks via the "+" button — never read by auth |
| `DPR.notes` | DPR | Free-text |
| `DPR.workEntries` (Json, deprecated) | DPR | Old nested structure retained for back-compat |
| `InspectionRecord.projectName`, `location`, `contractor`, `data` (Json), `severity`, `weather` | Inspection | Same as DPR — site-level reporting fields |
| `DPRPhoto.caption`, `DPRPhoto.location` | DPRPhoto | Photo metadata |
| `InspectionPhoto.caption`, `InspectionPhoto.location` | InspectionPhoto | Photo metadata |
| `LeaveRequest.reason`, `LeaveRequest.reviewNotes` | LeaveRequest | Narrative |
| `LeaveRequest.metadata` (Json) | LeaveRequest | Reserved for future HR policy hooks |
| `TrainingEnrollment.employeeNote`, `evidenceMetadata` (Json) | TrainingEnrollment | Self-attested / audit metadata |
| `Attendance.notes` | Attendance | Day-level free text |
| `AttendanceSession.checkInAddr`, `checkOutAddr` | AttendanceSession | Reverse-geocoded address — convenience for the user, never used for access control |
| `AttendanceSession.checkInLat`, `checkInLng`, `checkOutLat`, `checkOutLng` | AttendanceSession | Geo; not used as a tenant check |

If you find yourself writing a route that filters by `projectName` to
"show only my organization's projects" — stop. That is the tenancy bug.
Filter by the authenticated `employeeId` (or, after onboarding, by
`organizationId`).

---

## 5. Why This PR Is Safe to Ship Today

The current deployment has no second organization. Concretely:

| Assumption | How it is enforced today |
|---|---|
| Only one organization will ever sign in | `ALLOWED_EMAIL_DOMAINS` defaults to `['acschennai.com']`; `Employee` rows are unique on `email` |
| Admin role is global (not per-org) | `Employee.isAdmin` is a single `Boolean` column; there is no `Organization.adminId` |
| All storage lives in one R2 account | `ALLOWED_R2_BUCKETS` in `backend/src/lib/blobStorage.js` lists three buckets in the same account; CORS policy is applied to each at boot via `applyR2Cors()` |
| All web origins are known up front | `ALLOWED_ORIGINS` env var; production boot fails fast if unset |
| No org-isolated backup / restore | Supabase project is single-tenant |
| Audit logs do not record `organizationId` | True — and acceptable because there is only one org, so the value would be a constant |

Adding a second org breaks every assumption above. The boot-time
assertion in `backend/src/index.js` (`SELECT COUNT(*) FROM employees`)
is intentionally non-restrictive today — it logs the count and warns if
it exceeds a documented workforce size — but it does NOT hard-fail. That
is deliberate: a future engineer adding the second org will see the
tenancy link during every boot and treat it as a checklist item, not a
silently-shipping assumption.

---

## 6. Pre-Onboarding Checklist (Future Second Org)

If/when a second external organization is onboarded to the same API
process, **do not skip any of these.** Each one is a class of bug, not
a single instance.

- [ ] **Schema — add `Organization` model.** At minimum:
      `id`, `slug` (unique), `name`, `createdAt`. Add to `schema.prisma`,
      run `prisma db push` (or migration), regenerate the client.
- [ ] **Schema — add `Employee.organizationId`.** FK, NOT NULL, indexed.
      Backfill existing rows with a single `Organization` row before
      setting NOT NULL; do not leave NULLs in production.
- [ ] **Auth — derive org from session.** `requireAuth` middleware must
      attach `req.organizationId` from the JWT or from a single
      `Employee.findUnique` lookup. All downstream middleware should
      read it from `req`, not re-query.
- [ ] **Auth — `isAdmin` becomes per-org.** Either a join table
      (`OrganizationMember(employeeId, organizationId, role)`) or a
      `EmployeeRole` table. The single global `isAdmin` boolean must
      be removed; no admin check may pass without an explicit
      `organizationId` predicate.
- [ ] **OAuth admission — per-org allowlist.** Replace the global
      `ALLOWED_EMAIL_DOMAINS` env var with `Organization.allowedEmailDomains`
      (or a join table). The callback resolves the org from the email
      domain BEFORE creating / updating the Employee row.
- [ ] **OAuth admission — `findOrCreateEmployee` learns the org.** The
      function in `backend/src/routes/auth.js` must assign
      `organizationId` on `create` and must not silently let a
      same-email row migrate between orgs.
- [ ] **All Prisma queries filter by `organizationId`.** Audit every
      route file in `backend/src/routes/` and every lib file in
      `backend/src/lib/` for `prisma.<model>.find*` calls that do
      NOT include an `organizationId` predicate. The audit should be
      mechanical (grep + review), not aspirational.
- [ ] **Storage paths prefix by `organizationId`.** Every blob path in
      `backend/src/lib/blobStorage.js` (`generateUploadSASUrl`,
      `uploadBufferToBlob`, `deleteBlob`) must include
      `${organizationId}/${...}` so one org's bucket reader cannot see
      another's objects. Consider also moving to per-org buckets.
- [ ] **Audit events record `organizationId`.** Every `Notification`,
      every `DPRRevision`, every admin-actor write must carry
      `organizationId` in the payload (schema or JSON metadata).
- [ ] **CSP / CORS origins list per org.** `ALLOWED_ORIGINS` in
      `backend/src/index.js` becomes a per-organization list, not a
      single env var. No wildcards, ever.
- [ ] **Admin role check includes `organizationId` predicate.** The
      `requireAdmin` middleware (and every inline `if (employee.isAdmin)`
      check) must verify `employee.organizationId === req.organizationId`.
      A super-admin role (across all orgs) is a separate explicit role,
      not the same `isAdmin` boolean.
- [ ] **Boot-time assertion becomes a hard constraint.** The current
      log-only check in `backend/src/index.js` should hard-fail when
      `Employee.organizationId` has more than N distinct values or when
      it does not match the configured allowlist.
- [ ] **Tests per organization.** The `backend/__tests__/` suite
      should add at least one "cross-org" test per resource (DPR,
      inspection, leave, training, attendance) — confirm that a user
      from org A cannot read or mutate org B's data via any endpoint.
- [ ] **Deploy topology reviewed.** If a second org needs an isolated
      data plane (regulatory / contractual), Render + Supabase + R2
      topology needs a separate service / DB / bucket prefix. The
      "shared process" assumption in §5 is not a contract.

When all of the above are done, the boot-time count assertion can be
replaced with a per-organization count assertion. Until then, the
single-tenant assumption holds.

---

## 7. How to Update This Document

This file is enforced by `.github/workflows/tenancy-doc.yml` — the
workflow fails any push that removes `TENANCY.md` or strips the word
`ACS` from it. If a section becomes stale:

1. Edit in the same PR that changes the behavior it documents.
2. The CI check is content-aware, not regex-strict — keep the word
   "ACS" somewhere in the document so the guardrail stays green.
3. Do not rename the file. The workflow hard-codes `TENANCY.md`.
