// N17 (Project-level dashboard with KPI tiles): lightweight Project master
// + KPI aggregation endpoint.
//
// Half-step to N1 (full Project module, XL). The dashboard needs a project
// dimension today so the PM can see "DPRs pending review this week",
// "Inspections open", "Cube tests due", "BOQ variance", etc. grouped by
// project — but RFI, Drawings, and a full Project module are out of scope.
//
// What this router does:
//   GET    /api/projects                  list (active + auto-discovered)
//   POST   /api/projects                  create (admin)
//   GET    /api/projects/:idOrName        detail (resolved by id or name)
//   PATCH  /api/projects/:id              update (admin)
//   DELETE /api/projects/:id              soft-delete via isActive=false (admin)
//   GET    /api/projects/:idOrName/kpis   aggregated counts for the dashboard
//   GET    /api/projects/:idOrName/parties  (N1) project-anchor sidebar payload
//
// Auth model: same as DPR / Inspection — requireAuth on every route, with
// `requireFreshAdmin` on the mutations (admin-claim TTL is 15m, so a
// freshly demoted admin cannot create/update/delete projects with a stale
// token). KPI endpoint is auth-only so any employee can view the public
// summary for projects they have access to.
//
// Defensive coding for in-flight sibling features: CubeTest (N5) and
// BoqItem (N7) ship in parallel rounds. The KPI endpoint tolerates a
// `prisma.cubeTest` or `prisma.boqItem` that throws — every such call is
// wrapped in its own try/catch so a failure in one roll-up does not 500
// the whole dashboard. Today both models ARE defined; the try/catch is
// forward-compat for a future migration window where one might be
// temporarily absent (e.g. hot-fixing a DROP/CREATE between deploys).

'use strict';

const express = require('express');
const router = express.Router();
const { requireAuth, requireFreshAdmin } = require('../middleware/auth');
const { mapPrismaError, parseStrictISODate } = require('../lib/errors');
const { hashIdentifier } = require('../lib/pii');
const { getTodayBusinessDate } = require('../lib/dateOnly');

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function getPrisma(req) { return req.app.get('prisma'); }

// ─── Field-length caps ──────────────────────────────────────────────────────
// Kept in one map so a future "max-length review" hits every string field
// at once. The frontend renders project metadata in admin tables, so
// 200 chars is the same cap DPR.projectName / InspectionRecord.projectName
// use — large enough for "T-Nagar Residential Complex — Phase II".
//
// N1 widening: `description` gets a 4000-char cap (long-form narrative
// the project-anchor page renders as a paragraph block); the other
// columns are unchanged from the original N17 set.
const FIELD_MAX = {
  name: 200,
  code: 60,
  client: 200,
  location: 200,
  description: 4000,
};

// Cap on the number of assignment rows per project. Stops a runaway
// admin from posting a 10k-element `assignments` array that would lock
// the project table for the duration of the diff transaction. 100 is
// well above the largest realistic project team — a 200-engineer mega-
// project would be split into sub-projects long before this is hit.
const MAX_ASSIGNMENTS_PER_PROJECT = 100;

// ─── JSON helpers (N1 widening) ──────────────────────────────────────────────
// `parties` and `sites` are JSONB columns — the client sends them as either
// already-parsed JSON objects or as JSON-encoded strings (the frontend
// historically stringified before fetch). `validateJsonField` normalises
// both shapes to a plain JS value or rejects with 400 if the field is
// neither. The caps on parties / sites are intentionally loose (a party
// record is a small object; sites is an array of small objects) — the
// per-field length cap is the abuse-prevention layer, not a contract.
function validateJsonField(raw, fieldName) {
  if (raw == null) return { ok: true, value: null };
  if (typeof raw === 'object') return { ok: true, value: raw };
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return { ok: true, value: parsed };
    } catch (e) {
      return { ok: false, error: `${fieldName} must be valid JSON` };
    }
  }
  return { ok: false, error: `${fieldName} must be an object/array or a JSON string` };
}

function validateContractValue(raw) {
  if (raw == null || raw === '') return { ok: true, value: null };
  // Accept number, numeric string, or stringified Decimal. Reject NaN /
  // Infinity / negatives — contract value is always non-negative, and
  // capping at 999_999_999_999.99 mirrors the column's NUMERIC(15,2)
  // ceiling so a typo'd 14-digit value fails fast instead of silently
  // saturating the column.
  const n = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 999999999999.99) {
    return { ok: false, error: 'contractValue must be a non-negative number ≤ 999999999999.99' };
  }
  return { ok: true, value: n };
}

// Validate a single assignment object. Returns the normalised shape
// `{ employeeId, role }` (employeeId always present + UUID; role null
// if absent or empty). The caller is responsible for verifying that
// `employeeId` exists in the `employees` table — we only do shape
// validation here so this function can be reused across POST + PATCH
// without duplicating the DB-existence check.
const ASSIGNMENT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ASSIGNMENT_ROLE_MAX = 60;

function validateAssignment(raw, indexHint) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: `assignments[${indexHint}] must be an object` };
  }
  const { employeeId, role } = raw;
  if (typeof employeeId !== 'string' || !employeeId.trim()) {
    return { ok: false, error: `assignments[${indexHint}].employeeId is required` };
  }
  const trimmedId = employeeId.trim();
  if (!ASSIGNMENT_UUID_RE.test(trimmedId)) {
    return { ok: false, error: `assignments[${indexHint}].employeeId must be a UUID`, code: 'INVALID_UUID' };
  }
  let normalisedRole = null;
  if (role != null && role !== '') {
    if (typeof role !== 'string') {
      return { ok: false, error: `assignments[${indexHint}].role must be a string` };
    }
    const trimmedRole = role.trim();
    if (trimmedRole.length > ASSIGNMENT_ROLE_MAX) {
      return { ok: false, error: `assignments[${indexHint}].role exceeds ${ASSIGNMENT_ROLE_MAX} chars` };
    }
    normalisedRole = trimmedRole || null;
  }
  return { ok: true, value: { employeeId: trimmedId, role: normalisedRole } };
}

function validateProjectPayload(body, { partial = false } = {}) {
  const out = {};
  if (!partial || body.name !== undefined) {
    if (typeof body.name !== 'string' || !body.name.trim()) {
      return { ok: false, error: 'name is required and must be a non-empty string' };
    }
    out.name = body.name.trim();
  }
  if (!partial || body.code !== undefined) {
    if (body.code == null || body.code === '') {
      out.code = null;
    } else if (typeof body.code !== 'string') {
      return { ok: false, error: 'code must be a string' };
    } else {
      out.code = body.code.trim();
    }
  }
  if (!partial || body.client !== undefined) {
    out.client = body.client == null ? null : (typeof body.client === 'string' ? body.client.trim() : null);
    if (body.client != null && typeof body.client !== 'string') {
      return { ok: false, error: 'client must be a string' };
    }
  }
  if (!partial || body.location !== undefined) {
    out.location = body.location == null ? null : (typeof body.location === 'string' ? body.location.trim() : null);
    if (body.location != null && typeof body.location !== 'string') {
      return { ok: false, error: 'location must be a string' };
    }
  }
  if (!partial || body.startDate !== undefined) {
    if (body.startDate == null || body.startDate === '') {
      out.startDate = null;
    } else {
      const p = parseStrictISODate(body.startDate);
      if (!p.ok) return { ok: false, error: 'startDate must be a valid YYYY-MM-DD' };
      out.startDate = p.date;
    }
  }
  if (!partial || body.expectedEndDate !== undefined) {
    if (body.expectedEndDate == null || body.expectedEndDate === '') {
      out.expectedEndDate = null;
    } else {
      const p = parseStrictISODate(body.expectedEndDate);
      if (!p.ok) return { ok: false, error: 'expectedEndDate must be a valid YYYY-MM-DD' };
      out.expectedEndDate = p.date;
    }
  }
  // Cross-field guard: expectedEndDate must be >= startDate when both set.
  if (out.startDate && out.expectedEndDate && out.expectedEndDate < out.startDate) {
    return { ok: false, error: 'expectedEndDate must be on or after startDate' };
  }
  // [N1] parties + sites + contractValue + description widen the project
  // payload. All four are nullable; the validators above return 400 on
  // invalid shapes. Prisma accepts the parsed value as-is for JSONB
  // columns (it stringifies internally) and the Number we coerce
  // contractValue into matches the column's NUMERIC(15,2) ceiling.
  if (!partial || body.parties !== undefined) {
    const v = validateJsonField(body.parties, 'parties');
    if (!v.ok) return { ok: false, error: v.error };
    out.parties = v.value;
  }
  if (!partial || body.sites !== undefined) {
    const v = validateJsonField(body.sites, 'sites');
    if (!v.ok) return { ok: false, error: v.error };
    out.sites = v.value;
  }
  if (!partial || body.contractValue !== undefined) {
    const v = validateContractValue(body.contractValue);
    if (!v.ok) return { ok: false, error: v.error };
    out.contractValue = v.value;
  }
  if (!partial || body.description !== undefined) {
    out.description = body.description == null
      ? null
      : (typeof body.description === 'string' ? body.description : null);
    if (body.description != null && typeof body.description !== 'string') {
      return { ok: false, error: 'description must be a string or null' };
    }
  }
  // [Project Assignments] optional `assignments` array. Shape only here;
  // the route handler verifies each employeeId exists in `employees`
  // after the validation pass so we can return a precise
  // EMPLOYEE_NOT_FOUND code rather than letting Prisma throw a foreign-
  // key constraint violation.
  //
  // Back-compat: when `assignments` is absent the handler leaves
  // existing rows untouched (the route handler treats undefined as
  // "no change", distinct from `[]` which means "delete all").
  if (!partial || body.assignments !== undefined) {
    if (body.assignments == null) {
      // null/missing → no change. Use undefined to delete-all.
      out.assignments = undefined;
    } else if (!Array.isArray(body.assignments)) {
      return { ok: false, error: 'assignments must be an array' };
    } else {
      if (body.assignments.length > MAX_ASSIGNMENTS_PER_PROJECT) {
        return {
          ok: false,
          error: `assignments exceeds ${MAX_ASSIGNMENTS_PER_PROJECT} entries`,
        };
      }
      const validated = [];
      for (let i = 0; i < body.assignments.length; i += 1) {
        const r = validateAssignment(body.assignments[i], i);
        if (!r.ok) {
          return { ok: false, error: r.error, code: r.code };
        }
        validated.push(r.value);
      }
      // De-duplicate on employeeId (later wins). The DB has a unique
      // constraint on (projectId, employeeId) so a duplicate here would
      // otherwise surface as a P2002 race-prone error.
      const deduped = [];
      const seen = new Set();
      for (const a of validated) {
        if (!seen.has(a.employeeId)) {
          seen.add(a.employeeId);
          deduped.push(a);
        }
      }
      out.assignments = deduped;
    }
  }
  // Length caps
  for (const [k, cap] of Object.entries(FIELD_MAX)) {
    if (out[k] != null && typeof out[k] === 'string' && out[k].length > cap) {
      return { ok: false, error: `${k} exceeds ${cap} chars` };
    }
  }
  return { ok: true, data: out };
}

// ─── idOrName resolution ────────────────────────────────────────────────────
// The KPI endpoint accepts either a project UUID or a free-text name. Names
// are URL-encoded so "T-Nagar / Phase II" becomes "T-Nagar%20%2F%20Phase%20II"
// — Express decodes that automatically. We try the UUID match first
// (single PK lookup) and fall back to a name match (unique index).
//
// Returns one of:
//   { kind: 'project', project: <row> }   — exact id or exact-name match
//   { kind: 'discovered', name: <string> } — not registered; auto-discovery
//                                          from DPR.projectName still works
//   { kind: 'missing' }                    — neither id nor name known
async function resolveProject(prisma, idOrName) {
  if (!idOrName) return { kind: 'missing' };
  const decoded = decodeURIComponent(idOrName);

  // Try UUID first — Prisma's findUnique throws on malformed UUID via the
  // query layer, so we guard with the same regex the rest of the codebase
  // uses. A non-UUID idOrName falls through to the name match.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (UUID_RE.test(decoded)) {
    const project = await prisma.project.findUnique({ where: { id: decoded } });
    if (project) return { kind: 'project', project };
    // A valid UUID with no row is "missing" — don't fall through to the
    // name match, the caller passed us an id and we should honour it.
    return { kind: 'missing' };
  }

  // Name match: unique on Project.name. Try exact first, then case-insensitive
  // so "t-nagar" still resolves to "T-Nagar" (a common PM typo).
  const project = await prisma.project.findUnique({ where: { name: decoded } });
  if (project) return { kind: 'project', project };
  const ci = await prisma.project.findFirst({
    where: { name: { equals: decoded, mode: 'insensitive' } },
  });
  if (ci) return { kind: 'project', project: ci };

  // Not registered. The dashboard can still surface KPIs grouped by
  // DPR.projectName — return the name so the KPI handler can issue a
  // string match against DPR / InspectionRecord.
  return { kind: 'discovered', name: decoded };
}

function serializeProject(row) {
  if (!row) return null;
  // Decimal columns serialize via .toString() (Prisma default for Decimal).
  // That preserves precision and round-trips cleanly through JSON; the
  // frontend parses with `new Decimal(...)` or coerces to Number for
  // display. We do NOT coerce to Number here — a 15-digit contract value
  // would silently lose precision through `Number()`.
  const contractValueRaw = row.contractValue;
  const contractValue = contractValueRaw == null
    ? null
    : (typeof contractValueRaw === 'string' || typeof contractValueRaw === 'number')
      ? contractValueRaw
      : (typeof contractValueRaw.toString === 'function' ? contractValueRaw.toString() : contractValueRaw);
  // [Project Assignments] if the caller included `assignments` in the
  // Prisma fetch's `include`, surface them as a flat array with the
  // employee object inlined. The POST/PATCH/GET handlers below control
  // whether assignments are loaded — the list endpoint deliberately
  // does NOT include them (list payload is large enough already).
  const assignments = Array.isArray(row.assignments)
    ? row.assignments.map(serializeAssignment)
    : undefined;
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    client: row.client,
    location: row.location,
    // [N1] widening — see validateProjectPayload above for the input shape.
    parties: row.parties ?? null,
    contractValue,
    sites: row.sites ?? null,
    description: row.description ?? null,
    isActive: row.isActive,
    startDate: row.startDate instanceof Date ? row.startDate.toISOString().slice(0, 10) : row.startDate,
    expectedEndDate: row.expectedEndDate instanceof Date ? row.expectedEndDate.toISOString().slice(0, 10) : row.expectedEndDate,
    createdById: row.createdById,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt,
    // Only emit `assignments` when the fetch included them — keeps the
    // list endpoint payload unchanged for callers that haven't asked.
    ...(assignments !== undefined ? { assignments } : {}),
  };
}

// Row → JSON for a single ProjectAssignment. Used by serializeProject
// (when the caller included `assignments` in the include) and by the
// dedicated GET /api/projects/:idOrName/assignments endpoint.
//
// `row.employee` may be undefined when the fetch didn't include the
// employee join — we still emit the bare FK so the caller can pivot on
// employeeId. The dedicated assignments endpoint always includes the
// join so the UI gets name + email + designation.
function serializeAssignment(row) {
  if (!row) return null;
  return {
    id: row.id,
    employeeId: row.employeeId,
    role: row.role ?? null,
    assignedAt: row.assignedAt instanceof Date ? row.assignedAt.toISOString() : row.assignedAt,
    employee: row.employee
      ? {
          id: row.employee.id,
          name: row.employee.name,
          email: row.employee.email,
          designation: row.employee.designation ?? null,
        }
      : null,
  };
}

// Shared `include` shape for the project fetches that surface assignments.
// Used by the POST/PATCH handlers (post-mutation re-fetch so the response
// carries the freshly-written rows) and by the dedicated GET endpoint.
const PROJECT_WITH_ASSIGNMENTS_INCLUDE = {
  assignments: {
    orderBy: { assignedAt: 'asc' },
    include: {
      employee: { select: { id: true, name: true, email: true, designation: true } },
    },
  },
};

// Diff `desired` (validated, de-duplicated `{employeeId, role}[]`)
// against the existing rows for a project and apply the changes inside a
// single transaction. The diff:
//
//   * creates rows for every (projectId, employeeId) pair in `desired`
//     that doesn't already exist;
//   * deletes rows for every existing (projectId, employeeId) pair that
//     isn't in `desired`;
//   * updates the role on every (projectId, employeeId) pair that
//     appears in BOTH sets when the desired role differs from the
//     stored role (preserves id + assignedAt + assignedById — DR-010).
//
// The role update closes the silent-success hole in the prior contract
// where a role edit would PATCH200 and the change would be discarded
// silently because the diff saw the row as unchanged. The update is
// idempotent — re-sending the same payload is a no-op; a PATCH with the
// same assignments array twice → still one row (see round-25d
// scope-bleed lesson on transactions).
//
// `assignedById` is derived from `req.employeeId` — the request body is
// never consulted, even on PATCH where the user could otherwise
// impersonate another admin via `assignedById`.
//
// Returns the freshly-fetched assignment rows so the caller can
// include them in the response payload.
//
// Throws an Error tagged with `.code = 'EMPLOYEE_NOT_FOUND'` if any
// supplied employeeId doesn't resolve — the route handler maps this to
// 400 with the offending IDs in the response.
async function syncProjectAssignments(tx, projectId, desired, req) {
  const employeeIds = desired.map((a) => a.employeeId);

  // Validate the employee set exists. Use findMany + Set lookup rather
  // than a separate findUnique per id — fewer round-trips, single
  // query plan.
  if (employeeIds.length) {
    const existing = await tx.employee.findMany({
      where: { id: { in: employeeIds } },
      select: { id: true },
    });
    const found = new Set(existing.map((e) => e.id));
    const missing = employeeIds.filter((id) => !found.has(id));
    if (missing.length) {
      const err = new Error('One or more assignments reference an unknown employee');
      err.code = 'EMPLOYEE_NOT_FOUND';
      err.missingEmployeeIds = missing;
      throw err;
    }
  }

  // Existing rows for this project.
  const existingRows = await tx.projectAssignment.findMany({
    where: { projectId },
    select: { id: true, employeeId: true, role: true },
  });
  const existingByEmp = new Map(existingRows.map((r) => [r.employeeId, r]));
  const desiredByEmp = new Map(desired.map((a) => [a.employeeId, a]));

  // Diff.
  const toCreate = [];
  const toDelete = [];
  // [DR-010] — for retained employeeIds, queue an UPDATE when the
  // desired role differs from the stored role. The previous contract
  // silently dropped role edits (the row was unchanged in the set-diff,
  // so the role diff was never seen). Re-using the same id/assignedAt
  // /assignedById means the audit trail stays intact; only `role` is
  // written. `desiredRole === storedRole` (incl. both null) is a no-op
  // so PATCH-with-same-payload stays idempotent.
  const toUpdate = [];
  for (const [empId, desiredRow] of desiredByEmp.entries()) {
    const existing = existingByEmp.get(empId);
    if (!existing) {
      toCreate.push(empId);
    } else if ((existing.role ?? null) !== (desiredRow.role ?? null)) {
      toUpdate.push({ id: existing.id, employeeId: empId, role: desiredRow.role });
    }
  }
  for (const [empId, _row] of existingByEmp.entries()) {
    if (!desiredByEmp.has(empId)) toDelete.push(empId);
  }

  // Apply. `createMany` skips the round-trip-per-row overhead; the
  // @@unique([projectId, employeeId]) constraint prevents duplicates
  // (and we just de-duplicated client-side above, so this is safe).
  if (toCreate.length) {
    await tx.projectAssignment.createMany({
      data: toCreate.map((employeeId) => ({
        projectId,
        employeeId,
        role: desiredByEmp.get(employeeId).role,
        assignedById: req.employeeId,
      })),
    });
  }
  if (toUpdate.length) {
    // Per-row update preserves id + assignedAt + assignedById; only
    // role is rewritten. updateMany would skip rows where role is
    // already null (a legitimate target), so per-row is safer.
    for (const row of toUpdate) {
      await tx.projectAssignment.update({
        where: { id: row.id },
        data: { role: row.role },
      });
    }
  }
  if (toDelete.length) {
    await tx.projectAssignment.deleteMany({
      where: { projectId, employeeId: { in: toDelete } },
    });
  }

  // Return the fresh state so the caller can render it without a second
  // round-trip. The returned rows do NOT carry the employee join — the
  // route handler will re-fetch with the include if it needs the
  // joined shape.
  return tx.projectAssignment.findMany({
    where: { projectId },
    orderBy: { assignedAt: 'asc' },
  });
}

router.use(requireAuth);

// ─── GET /api/projects ──────────────────────────────────────────────────────
// Lists curated projects (active only) PLUS names auto-discovered from
// existing DPR.projectName values that have no Project row yet. The two
// sets are returned separately — the frontend merges / scopes them.
//
// Scopes:
//   ?scope=all       admin-only — full curated list + org-wide auto-
//                    discovered names. Any other caller → 403.
//   ?scope=mine      (default for non-admin) — full curated list + ONLY
//                    auto-discovered names that this employee has
//                    personally filed DPRs/Inspections against. Closes
//                    the data leak where employees could see admin test
//                    rigs and contracts they have no business knowing
//                    about.
//   ?scope=assigned  employee-only — curated list narrowed to ONLY the
//                    projects the employee has personally touched (filed
//                    a DPR / Inspection / BoqItem / VariationOrder /
//                    Drawing against), plus auto-discovered names from
//                    the same set. Used by the employee-facing Drawings
//                    picker so a field engineer only sees projects they
//                    have actual context on, instead of the full
//                    org-wide curated list. No ProjectMembership table
//                    is needed — the join is derived from the existing
//                    audit columns on the child rows.
//
//                    [Round-32.1 bugfix] Projects the employee merely
//                    created (Project.createdById === req.employeeId)
//                    are NOT included unless they also filed a child
//                    record against them. The dropdown should reflect
//                    actual work history, not create-side activity.
//   no param         legacy callers get the safe default (same as
//                    ?scope=mine).
//
// Auth: any employee.
router.get('/', asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  if (!prisma) {
    return res.status(503).json({ error: 'Database unavailable', code: 'DB_UNAVAILABLE' });
  }

  const scope = (req.query.scope || 'mine').toString();
  if (!['mine', 'all', 'assigned'].includes(scope)) {
    return res.status(400).json({ error: 'scope must be "mine", "all", or "assigned"', code: 'INVALID_SCOPE' });
  }
  if (scope === 'all' && !req.isAdmin) {
    return res.status(403).json({ error: 'Admin access required', code: 'ADMIN_REQUIRED' });
  }

  try {
    const [projects, dprNames, inspectionNames] = await Promise.all([
      prisma.project.findMany({
        // Curated rows: every active project is visible to every employee
        // by default. The `?scope=assigned` branch below filters this set
        // down to only the projects the requesting employee has personally
        // touched via child records (DPR / Inspection / BoqItem /
        // VariationOrder / Drawing).
        where: { isActive: true },
        orderBy: [{ name: 'asc' }],
        select: {
          id: true, name: true, code: true, client: true, location: true,
          // [N1] widening — list endpoint surfaces the new metadata
          // columns so the frontend's project picker can render
          // client/location chips without a per-row detail round-trip.
          parties: true, contractValue: true, sites: true, description: true,
          isActive: true, startDate: true, expectedEndDate: true,
          createdById: true, createdAt: true, updatedAt: true,
        },
      }),
      // Auto-discovery: distinct project names that exist on DPR rows but
      // are NOT yet in the Project table. Scoped to the employee when
      // scope=mine/assigned so admin test rigs / contract codes they
      // never filed against don't surface in their dropdown.
      //
      // [bugfix round-30] Earlier code filtered on `createdById` but
      // `DPR` has no `createdById` column — the schema uses
      // `submittedById` exclusively. Prisma 5.22 raised
      // PrismaClientValidationError asynchronously on the unknown
      // column, which the inline `.catch(() => [])` swallowed
      // silently — meaning `?scope=mine` returned zero DPR-discovered
      // names for every employee. The fix is to filter on the real
      // column (`submittedById`).
      //
      // [DR-032 round-35.5] Tightened to `projectId: null` so the
      // discovered list reflects TRUE orphans only. Previously the
      // distinct query was over the full table — a stale non-orphan
      // row (projectId=<other>, projectName=<source>) kept the source
      // name in Discovered even after a merge cleared all orphan rows
      // with that name. The merge endpoint's WHERE also locks to
      // projectId:null, so a merge genuinely removing orphans now
      // drops the source from this list. Behaviour for non-all scopes
      // is unchanged in spirit (still scoped to the requester's
      // submittedById) — only the orphan lock is added.
      scope === 'all'
        ? prisma.dPR.findMany({
            where: { projectId: null },
            distinct: ['projectName'],
            select: { projectName: true },
            orderBy: { projectName: 'asc' },
          }).catch((err) => {
            console.warn('Projects list — DPR auto-discovery failed', {
              prismaCode: err.code,
              message: err.message?.split('\n')[0],
            });
            return [];
          })
        : prisma.dPR.findMany({
            where: { projectId: null, submittedById: req.employeeId },
            distinct: ['projectName'],
            select: { projectName: true },
            orderBy: { projectName: 'asc' },
          }).catch((err) => {
            console.warn('Projects list — DPR auto-discovery (mine/assigned) failed', {
              prismaCode: err.code,
              message: err.message?.split('\n')[0],
            });
            return [];
          }),
      // Same scoping for InspectionRecord.projectName — an employee who
      // only ever filed inspections against "RESOLVE-TEST-PROJECT-NEW"
      // should see that name in their dropdown, even if they never filed
      // a DPR against it. Scope=all ALSO pulls org-wide inspection names
      // so admins see a complete org-wide discovered list.
      //
      // [DR-032 round-35.5] Same orphan lock as the DPR query above —
      // non-orphan rows with a stale projectName don't keep the source
      // alive in Discovered after a merge.
      scope === 'all'
        ? prisma.inspectionRecord.findMany({
            where: { projectId: null },
            distinct: ['projectName'],
            select: { projectName: true },
            orderBy: { projectName: 'asc' },
          }).catch(() => [])
        : prisma.inspectionRecord.findMany({
            where: { projectId: null, submittedById: req.employeeId },
            distinct: ['projectName'],
            select: { projectName: true },
            orderBy: { projectName: 'asc' },
          }).catch(() => []),
    ]);

    // For ?scope=assigned, narrow the curated list to ONLY the projects
    // this employee has personally touched via any child record OR has
    // been explicitly allocated to via ProjectAssignment. We query six
    // audit/assignment sources in parallel (DPR.submittedById,
    // InspectionRecord.submittedById, BoqItem.createdById,
    // VariationOrder.raisedById, Drawing.issuedById,
    // ProjectAssignment.employeeId) and union the projectId sets.
    //
    // [Round-32.1 bugfix] The earlier implementation also matched
    // `Project.createdById === req.employeeId`, which leaked
    // projects the employee merely created (often as test artifacts)
    // into the dropdown even when they had no child records against
    // them. User feedback (R32.1): "a project name mentioned which
    // not from his dpr shown in that drop down" — the dropdown
    // should reflect actual work history, not create-side activity.
    // Projects created via the resolveProject flow now register the
    // new project's id and the employee files a child record against
    // it (DPR/Inspection/etc.) before it lands in their picker.
    //
    // [DR-010] The six-source union now ALSO includes
    // ProjectAssignment.employeeId — explicit roster membership is
    // distinct from history-based discovery (an admin may allocate
    // an employee to a brand-new project with no DPR/Inspection/BOQ
    // rows yet, and the assigned employee must see the project in
    // their picker immediately, without having to invent dummy
    // history first). The audit: "history-based discovery is
    // intentional, not automatically an authorization flaw" — this
    // is the bridge: roster + history, unioned.
    let filteredProjects = projects;
    if (scope === 'assigned') {
      const [dprProj, inspProj, boqProj, voProj, drwProj, assignProj] = await Promise.all([
        prisma.dPR.findMany({
          distinct: ['projectId'],
          where: { submittedById: req.employeeId, projectId: { not: null } },
          select: { projectId: true },
        }).catch(() => []),
        prisma.inspectionRecord.findMany({
          distinct: ['projectId'],
          where: { submittedById: req.employeeId, projectId: { not: null } },
          select: { projectId: true },
        }).catch(() => []),
        prisma.boqItem.findMany({
          distinct: ['projectId'],
          where: { createdById: req.employeeId, projectId: { not: null } },
          select: { projectId: true },
        }).catch(() => []),
        prisma.variationOrder.findMany({
          distinct: ['projectId'],
          where: { raisedById: req.employeeId },
          select: { projectId: true },
        }).catch(() => []),
        prisma.drawing.findMany({
          distinct: ['projectId'],
          where: { issuedById: req.employeeId, projectId: { not: null } },
          select: { projectId: true },
        }).catch(() => []),
        // [DR-010] Explicit roster membership. Admins create a
        // ProjectAssignment row when allocating a project to an
        // employee — the assigned employee should see that project
        // in their picker before they've filed any child record.
        prisma.projectAssignment.findMany({
          distinct: ['projectId'],
          where: { employeeId: req.employeeId },
          select: { projectId: true },
        }).catch(() => []),
      ]);
      const touched = new Set([
        ...dprProj.map((r) => r.projectId),
        ...inspProj.map((r) => r.projectId),
        ...boqProj.map((r) => r.projectId),
        ...voProj.map((r) => r.projectId),
        ...drwProj.map((r) => r.projectId),
        ...assignProj.map((r) => r.projectId),
      ].filter(Boolean));
      filteredProjects = projects.filter((p) => touched.has(p.id));
    }

    const curatedNames = new Set(filteredProjects.map((p) => p.name));
    // [DR-012] Exclude names that match an archived Project row from the
    // discovered list. DPR.projectName / InspectionRecord.projectName are
    // free-text columns that retain their old value after the admin
    // archives (or renames) the parent Project row — without this filter
    // the employee-side picker re-surfaces the archived master as
    // "Not registered" instead of hiding it. Look up every distinct
    // discovered name against Project.name (case-insensitive) and drop
    // the ones that resolve to an isActive=false row. Best-effort: an
    // error in the archive-lookup should not 500 the whole list (the
    // curated list is still useful), so we fall back to the
    // unfiltered set and log a warning.
    const discoveredNamesRaw = [
      ...dprNames.map((d) => d.projectName),
      ...inspectionNames.map((i) => i.projectName),
    ];
    const distinctDiscovered = Array.from(new Set(discoveredNamesRaw)).filter((n) => n && !curatedNames.has(n));
    let archivedNames = new Set();
    if (distinctDiscovered.length) {
      try {
        const archivedRows = await prisma.project.findMany({
          where: {
            isActive: false,
            name: { in: distinctDiscovered },
          },
          select: { name: true },
        });
        archivedNames = new Set(archivedRows.map((r) => r.name));
      } catch (archiveErr) {
        console.warn('Projects list — archived-name lookup failed (continuing unfiltered)', {
          prismaCode: archiveErr.code,
          message: archiveErr.message?.split('\n')[0],
        });
      }
    }
    const discoveredNames = distinctDiscovered
      .filter((n) => !archivedNames.has(n))
      .sort((a, b) => a.localeCompare(b));

    res.json({
      projects: filteredProjects.map(serializeProject),
      // Discovered entries are light-weight — name only — because they
      // have no metadata yet. The frontend renders them with a "not yet
      // registered" badge and a CTA to the admin to create the row.
      discovered: discoveredNames.map((name) => ({
        name,
        isRegistered: false,
      })),
      scope,
    });
  } catch (err) {
    console.error('Projects list error', {
      employeeHash: hashIdentifier(req.employeeId),
      prismaCode: err.code,
      message: err.message?.split('\n')[0],
    });
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to fetch projects' });
  }
}));

// ─── POST /api/projects ─────────────────────────────────────────────────────
// Admin-curated create. Unique constraint on `name` means duplicates
// against existing DPR submissions surface as P2002 → 409 DUPLICATE
// (handled by mapPrismaError).
//
// requireFreshAdmin (not requireAdmin): a freshly demoted admin cannot
// keep creating projects with a stale-JWT for the rest of the 15-min
// access-token TTL.
//
// [Project Assignments] optional `assignments: [{employeeId, role}]`
// payload. When present, the entire create + assignment-insert runs
// inside one transaction so a partial failure rolls everything back.
router.post('/', requireFreshAdmin, asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  if (!prisma) {
    return res.status(503).json({ error: 'Database unavailable', code: 'DB_UNAVAILABLE' });
  }

  const v = validateProjectPayload(req.body || {});
  if (!v.ok) {
    return res.status(400).json({ error: v.error, code: v.code || 'VALIDATION_ERROR' });
  }

  // Pull `assignments` out of the validated payload — it isn't a column
  // on `project`, so we strip it before the create and apply it inside
  // the same transaction.
  const { assignments: desiredAssignments, ...projectData } = v.data;

  try {
    const project = await prisma.$transaction(async (tx) => {
      const created = await tx.project.create({
        data: {
          ...projectData,
          createdById: req.employeeId,
        },
      });
      if (Array.isArray(desiredAssignments)) {
        await syncProjectAssignments(tx, created.id, desiredAssignments, req);
      }
      // Re-fetch with the assignments include so the response carries
      // the freshly-written rows + the joined employee metadata.
      return tx.project.findUnique({
        where: { id: created.id },
        include: PROJECT_WITH_ASSIGNMENTS_INCLUDE,
      });
    });
    res.status(201).json(serializeProject(project));
  } catch (err) {
    if (err && err.code === 'EMPLOYEE_NOT_FOUND') {
      return res.status(400).json({
        error: err.message,
        code: 'EMPLOYEE_NOT_FOUND',
        missingEmployeeIds: err.missingEmployeeIds,
      });
    }
    console.error('Projects create error', {
      employeeHash: hashIdentifier(req.employeeId),
      prismaCode: err.code,
      message: err.message?.split('\n')[0],
    });
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to create project' });
  }
}));

// ─── POST /api/projects/resolve ─────────────────────────────────────────────
// Ensures a Project row exists for the supplied free-text `name`, returning
// the canonical UUID + name. The picker on DPR/Inspection submit surfaces
// auto-discovered projects as name-only (the `discovered` array on
// GET /api/projects); without a UUID the downstream DrawingPicker cannot
// filter drawings and the DPR POST payload would carry an invalid
// projectId. This endpoint closes the gap by promoting the name to a real
// row BEFORE submission, so DrawingPicker fires with a valid FK.
//
// Behaviour:
//   - name already registered → return the curated row, isRegistered=true.
//   - name not registered, active=true → create with minimal defaults
//     (name + createdById = caller; admin can curate later via PATCH).
//   - name not registered, matched an inactive row → 409 (the admin
//     archived it; reuse-after-archive is a deliberate manual step).
//
// Auth: any authenticated employee (mirrors POST /api/dpr which already
// auto-creates a discovered row server-side; we're just hoisting that
// step earlier so DrawingPicker can fire).
router.post('/resolve', asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  if (!prisma) {
    return res.status(503).json({ error: 'Database unavailable', code: 'DB_UNAVAILABLE' });
  }

  const rawName = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!rawName) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'name is required' });
  }
  if (rawName.length > 200) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'name must be 200 characters or fewer' });
  }

  try {
    // Case-insensitive lookup first — same precedence as resolveProject()
    // so a user who typed "t-nagar" gets the existing "T-Nagar" row
    // instead of spawning a duplicate.
    const existing = await prisma.project.findFirst({
      where: { name: { equals: rawName, mode: 'insensitive' } },
    });
    if (existing) {
      if (!existing.isActive) {
        return res.status(409).json({
          error: 'PROJECT_INACTIVE',
          code: 'PROJECT_INACTIVE',
          message: 'Project with this name is archived; ask an admin to re-activate or rename',
        });
      }
      return res.json({ ...serializeProject(existing), isRegistered: true });
    }

    // No row yet — create a minimal Project. `code` is intentionally left
    // null (admin can curate later via PATCH /api/projects/:id); we
    // default isActive=true so the user can immediately submit a DPR
    // referencing it.
    const created = await prisma.project.create({
      data: {
        name: rawName,
        createdById: req.employeeId,
        isActive: true,
      },
    });
    return res.status(201).json({ ...serializeProject(created), isRegistered: true });
  } catch (err) {
    // P2002 = unique violation on Project.name — a concurrent resolve
    // request just won the race. Re-read the canonical row so we still
    // return a valid UUID instead of a 500.
    if (err?.code === 'P2002') {
      const race = await prisma.project.findFirst({
        where: { name: { equals: rawName, mode: 'insensitive' } },
      });
      if (race) return res.json({ ...serializeProject(race), isRegistered: true });
    }
    console.error('Projects resolve error', {
      employeeHash: hashIdentifier(req.employeeId),
      prismaCode: err.code,
      message: err?.message?.split('\n')[0],
    });
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    return res.status(500).json({ error: 'Failed to resolve project' });
  }
}));

// ─── GET /api/projects/:idOrName ────────────────────────────────────────────
// Resolves by UUID or by name (case-insensitive). Returns the curated row
// if registered; otherwise returns 404 — the caller should treat the
// "discovered" case via the list endpoint's `discovered` array.
//
// LIVE-DISCOVERED: /:idOrName/kpis MUST be registered BEFORE /:idOrName
// in source order — Express routes them in declaration order, otherwise
// `GET /api/projects/<uuid>/kpis` would parse as :idOrName='<uuid>/kpis'
// (which decodes fine but never matches the UUID regex, so it falls
// through to the name match and 404s on the literal string '<uuid>/kpis').
// /:idOrName/parties follows the same ordering rule (added in N1 Phase A).
// /:idOrName/assignments follows the same ordering rule (added in N1
// Phase A — the project assignments read surface).
router.get('/:idOrName/kpis', asyncHandler(kpiHandler));
// ─── GET /api/projects/:idOrName/parties (N1) ───────────────────────────────
//
// Project-anchor sidebar payload. The frontend renders four pieces of
// metadata on the right rail of the project detail page: parties
// (client / contractor / consultant etc.), contract value (the
// total-contract amount for variance reports), sites (an array of
// site locations under this project), and description (long-form
// narrative). All four live on the Project row as N1 widening
// columns — this endpoint is the canonical read surface so the
// sidebar can render in a single round-trip.
//
// Auth: any authenticated employee. The KPI endpoint above is also
// any-auth; the metadata fields are not admin-only because they
// describe the project (public to anyone who can see the project
// row in the picker).
//
// Resolves by UUID or by name via the same resolveProject() helper
// the detail + KPI endpoints use. A discovered project (name with
// no Project row) returns an empty payload with a 200 + isRegistered
// flag so the frontend can show "no metadata yet" instead of 404.
router.get('/:idOrName/parties', asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  if (!prisma) {
    return res.status(503).json({ error: 'Database unavailable', code: 'DB_UNAVAILABLE' });
  }

  const result = await resolveProject(prisma, req.params.idOrName);
  if (result.kind === 'missing') {
    return res.status(404).json({ error: 'PROJECT_NOT_FOUND', code: 'PROJECT_NOT_FOUND', message: 'No project matches that id or name' });
  }
  if (result.kind === 'discovered') {
    // No curated row — return an empty payload so the sidebar renders
    // the "not registered yet" state without 404ing.
    return res.json({
      isRegistered: false,
      name: result.name,
      parties: null,
      contractValue: null,
      sites: null,
      description: null,
    });
  }
  // Registered project — return the four metadata fields. Prisma
  // returns the JSONB columns as already-parsed objects/arrays; the
  // contractValue Decimal serializes through .toString() per the
  // serializeProject contract (precision-preserving).
  const p = result.project;
  const contractValue = p.contractValue == null
    ? null
    : (typeof p.contractValue === 'string' || typeof p.contractValue === 'number')
      ? p.contractValue
      : (typeof p.contractValue.toString === 'function' ? p.contractValue.toString() : p.contractValue);
  res.json({
    isRegistered: true,
    name: p.name,
    parties: p.parties ?? null,
    contractValue,
    sites: p.sites ?? null,
    description: p.description ?? null,
  });
}));
// ─── GET /api/projects/:idOrName/assignments (Project Assignments) ─────────
//
// Canonical read surface for the assignment list. The POST / PATCH
// handlers also include `assignments` in their response payload, but a
// dedicated endpoint keeps the project-anchor "Team" panel from
// needing to fetch the whole project just to render the assignment
// list.
//
// Resolves by UUID or by name (case-insensitive) via the existing
// resolveProject helper. A discovered project (name with no curated
// row) returns `{ assignments: [], isRegistered: false, name }` so the
// panel can render "no project registered yet" without 404ing — the
// same shape /:idOrName/parties uses for symmetry.
//
// Auth: any authenticated employee. The assignment list is not admin-
// only — the picker + project-anchor surfaces it for everyone.
router.get('/:idOrName/assignments', asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  if (!prisma) {
    return res.status(503).json({ error: 'Database unavailable', code: 'DB_UNAVAILABLE' });
  }

  const result = await resolveProject(prisma, req.params.idOrName);
  if (result.kind === 'missing') {
    return res.status(404).json({ error: 'PROJECT_NOT_FOUND', code: 'PROJECT_NOT_FOUND', message: 'No project matches that id or name' });
  }
  if (result.kind === 'discovered') {
    return res.json({
      isRegistered: false,
      name: result.name,
      assignments: [],
    });
  }

  // Registered project — fetch assignments with the employee join.
  // Order by assignedAt ASC so the UI gets a stable, oldest-first
  // view (mirrors the order POST/PATCH return).
  const rows = await prisma.projectAssignment.findMany({
    where: { projectId: result.project.id },
    orderBy: { assignedAt: 'asc' },
    include: {
      employee: { select: { id: true, name: true, email: true, designation: true } },
    },
  });

  res.json({
    isRegistered: true,
    projectId: result.project.id,
    name: result.project.name,
    assignments: rows.map(serializeAssignment),
  });
}));
router.get('/:idOrName', asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  if (!prisma) {
    return res.status(503).json({ error: 'Database unavailable', code: 'DB_UNAVAILABLE' });
  }

  const result = await resolveProject(prisma, req.params.idOrName);
  if (result.kind === 'missing') {
    return res.status(404).json({ error: 'PROJECT_NOT_FOUND', code: 'PROJECT_NOT_FOUND', message: 'No project matches that id or name' });
  }
  if (result.kind === 'project') {
    // [Round-34] The detail endpoint surfaces the full project + assignments
    // so the frontend's Team tab and ProjectForm pre-populate without a
    // second round-trip. resolveProject() deliberately uses a lean fetch
    // for KPI/parties hot paths, so we re-fetch here with the assignments
    // include (cheap — single indexed JOIN per project).
    const full = await prisma.project.findUnique({
      where: { id: result.project.id },
      include: PROJECT_WITH_ASSIGNMENTS_INCLUDE,
    });
    return res.json(serializeProject(full || result.project));
  }
  // Discovered (name with no Project row): return a stub so the frontend
  // can render the empty-state with the project name. The N1 widening
  // adds the new metadata columns as nulls — discovered projects have no
  // curated metadata yet (the admin hasn't created the Project row).
  return res.json({
    name: result.name,
    isRegistered: false,
    isActive: true,
    client: null,
    location: null,
    parties: null,
    contractValue: null,
    sites: null,
    description: null,
    code: null,
    startDate: null,
    expectedEndDate: null,
  });
}));

// ─── PATCH /api/projects/:id ────────────────────────────────────────────────
// Admin-only update. Mass-assignment allowlist prevents IDOR on
// createdById / isActive (the soft-delete flag) / id. Mirrors the
// P0-1 pattern in dpr.js / inspection.js.
router.patch('/:id', requireFreshAdmin, asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  if (!prisma) {
    return res.status(503).json({ error: 'Database unavailable', code: 'DB_UNAVAILABLE' });
  }

  const { id } = req.params;
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_RE.test(id)) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Project id must be a UUID' });
  }

  const ALLOWED_UPDATE_FIELDS = [
    'name', 'code', 'client', 'location', 'startDate', 'expectedEndDate',
    // [N1] widening — admin can now update the project metadata via PATCH
    // (parties, sites, contractValue, description). The validation in
    // validateProjectPayload handles each field's shape / cap / parse
    // rules — same code path as POST, so a PATCH and a POST cannot drift.
    'parties', 'sites', 'contractValue', 'description',
    // [Project Assignments] optional mass-replace of the assignments
    // set. `assignments: []` means "remove everyone"; `assignments`
    // absent means "leave existing rows alone" (back-compat).
    'assignments',
  ];
  const fields = req.body || {};
  const unknown = Object.keys(fields).filter((k) => !ALLOWED_UPDATE_FIELDS.includes(k) && k !== 'isActive');
  if (unknown.length) {
    return res.status(400).json({
      error: 'UNKNOWN_FIELDS',
      message: `Fields not allowed: ${unknown.join(', ')}`,
      fields: unknown,
    });
  }
  // isActive is rejected through PATCH on purpose: the soft-delete flow is
  // a dedicated DELETE so the audit trail (deletedBy, deletedAt-equivalent)
  // stays on a single endpoint. We explicitly forbid it here rather than
  // silently dropping — clearer for the client.
  if ('isActive' in fields) {
    return res.status(400).json({
      error: 'USE_DELETE_FOR_SOFT_DELETE',
      message: 'isActive cannot be set via PATCH; use DELETE for soft-delete',
    });
  }

  const v = validateProjectPayload(fields, { partial: true });
  if (!v.ok) {
    return res.status(400).json({ error: v.error, code: v.code || 'VALIDATION_ERROR' });
  }

  // `assignments` in v.data is one of:
  //   * undefined — body.assignments absent → leave existing rows
  //                 untouched (back-compat)
  //   * []        — explicit empty array → remove everyone
  //   * Array     — replace existing set with this diff
  const wantsAssignmentSync = Object.prototype.hasOwnProperty.call(fields, 'assignments');
  const { assignments: desiredAssignments, ...projectData } = v.data;

  try {
    const updated = await prisma.$transaction(async (tx) => {
      const existing = await tx.project.findUnique({ where: { id } });
      if (!existing) {
        const err = new Error('Project not found');
        err.code = 'PROJECT_NOT_FOUND';
        throw err;
      }

      // [DR-011] Rename guard. Project identity is coupled to mutable
      // display names today — renaming a curated Project silently
      // breaks KPI rollups that group by DPR.projectName (see
      // kpiHandler below: `where: { projectName }`). When any child
      // table still references this projectId, refuse the rename and
      // tell the admin to create a new project for the new identity.
      // Same-name "renames" (e.g. client typo correction that resolves
      // back to the same canonical name) and non-name fields (code,
      // client, location, ...) are NOT guarded — see the test matrix
      // in backend/__tests__/projects.dr011.test.js.
      if (
        projectData.name !== undefined
        && projectData.name !== existing.name
      ) {
        const [dprC, inspectionC, boqC, voC, drawingC, assignmentC] = await Promise.all([
          tx.dPR.count({ where: { projectId: id } }),
          tx.inspectionRecord.count({ where: { projectId: id } }),
          tx.boqItem.count({ where: { projectId: id } }),
          tx.variationOrder.count({ where: { projectId: id } }),
          tx.drawing.count({ where: { projectId: id } }),
          tx.projectAssignment.count({ where: { projectId: id } }),
        ]);
        const counts = {
          dpr: dprC,
          inspection: inspectionC,
          boq: boqC,
          vo: voC,
          drawing: drawingC,
          assignment: assignmentC,
        };
        const total = dprC + inspectionC + boqC + voC + drawingC + assignmentC;
        if (total > 0) {
          const err = new Error(
            `Cannot rename project with ${total} child record(s); create a new project for the new identity`,
          );
          err.code = 'PROJECT_HAS_CHILD_RECORDS';
          err.status = 409;
          err.counts = counts;
          throw err;
        }
      }

      const baseUpdate = await tx.project.update({
        where: { id },
        data: projectData,
      });
      if (wantsAssignmentSync) {
        await syncProjectAssignments(
          tx,
          id,
          Array.isArray(desiredAssignments) ? desiredAssignments : [],
          req,
        );
      }
      // Re-fetch with the assignments include so the response carries
      // the post-mutation row set. Only include when the caller touched
      // assignments — otherwise the include is wasted work.
      return tx.project.findUnique({
        where: { id },
        include: wantsAssignmentSync ? PROJECT_WITH_ASSIGNMENTS_INCLUDE : undefined,
      });
    });
    res.json(serializeProject(updated));
  } catch (err) {
    if (err && err.code === 'EMPLOYEE_NOT_FOUND') {
      return res.status(400).json({
        error: err.message,
        code: 'EMPLOYEE_NOT_FOUND',
        missingEmployeeIds: err.missingEmployeeIds,
      });
    }
    if (err && err.code === 'PROJECT_NOT_FOUND') {
      return res.status(404).json({ error: 'PROJECT_NOT_FOUND', code: 'PROJECT_NOT_FOUND', message: 'Project not found' });
    }
    // [DR-011] Rename guard. The transaction throws this when any child
    // table still references the projectId — surface the counts so the
    // admin sees the per-table attribution.
    if (err && err.code === 'PROJECT_HAS_CHILD_RECORDS') {
      return res.status(409).json({
        error: err.message,
        code: 'PROJECT_HAS_CHILD_RECORDS',
        counts: err.counts,
      });
    }
    console.error('Projects update error', {
      employeeHash: hashIdentifier(req.employeeId),
      prismaCode: err.code,
      message: err.message?.split('\n')[0],
    });
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to update project' });
  }
}));

// ─── DELETE /api/projects/:id ───────────────────────────────────────────────
// Soft-delete via isActive=false. The Project row stays so historical DPRs
// that reference projectName (a free-text column) keep their group-by
// resolution intact.
router.delete('/:id', requireFreshAdmin, asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  if (!prisma) {
    return res.status(503).json({ error: 'Database unavailable', code: 'DB_UNAVAILABLE' });
  }

  const { id } = req.params;
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_RE.test(id)) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Project id must be a UUID' });
  }

  try {
    const existing = await prisma.project.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ error: 'PROJECT_NOT_FOUND', code: 'PROJECT_NOT_FOUND', message: 'Project not found' });
    }
    if (!existing.isActive) {
      // Idempotent: a second DELETE on an already-inactive project is a no-op
      // success rather than a 409. Mirrors soft-delete convention in
      // inspection.js (status transition to a terminal state is idempotent).
      return res.json(serializeProject(existing));
    }
    const updated = await prisma.project.update({
      where: { id },
      data: { isActive: false },
    });
    res.json(serializeProject(updated));
  } catch (err) {
    console.error('Projects delete error', {
      employeeHash: hashIdentifier(req.employeeId),
      prismaCode: err.code,
      message: err.message?.split('\n')[0],
    });
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to delete project' });
  }
}));

// ─── POST /api/projects/:targetId/merge-orphan-source ──────────────────────
// Re-attributes orphaned child rows (DPR / InspectionRecord / BoqItem) from a
// discovered project name onto an existing curated Project row.
//
// Use case: an admin sees "T-Nagar" in the Discovered list (DPRs filed
// against it but no Project row), then decides it really belongs to the
// curated "T-Nagar Phase II" Project. The orphaned rows must follow the
// merge so the dashboard KPI tiles stop showing zero.
//
// Scope (intentional YAGNI): only DPR / InspectionRecord / BoqItem are
// touched — these are the three models whose KPI roll-up filters by exact
// `projectName` (see kpiHandler below). VariationOrder and Drawing have no
// `projectName` column (FK-only) and never appear in the Discovered list,
// so they're not in scope here.
//
// `dryRun: true` returns the same per-table counts without committing —
// mirrors the established pattern in internal-upload-sweep.js and
// storage.js. The frontend preview modal uses this to confirm row counts
// before the destructive commit.
//
// Auth: requireFreshAdmin — same posture as POST / PATCH / DELETE on
// /api/projects.
router.post('/:targetId/merge-orphan-source', requireFreshAdmin, asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  if (!prisma) {
    return res.status(503).json({ error: 'Database unavailable', code: 'DB_UNAVAILABLE' });
  }

  const { targetId } = req.params;
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_RE.test(targetId)) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'targetId must be a UUID' });
  }

  const sourceName = typeof req.body?.sourceName === 'string' ? req.body.sourceName.trim() : '';
  if (!sourceName) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'sourceName is required' });
  }
  if (sourceName.length > 200) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'sourceName must be 200 characters or fewer' });
  }

  const dryRun = !!(req.body && req.body.dryRun === true);

  try {
    const target = await prisma.project.findUnique({ where: { id: targetId } });
    if (!target) {
      return res.status(404).json({
        error: 'PROJECT_NOT_FOUND',
        code: 'PROJECT_NOT_FOUND',
        message: 'Target project not found',
      });
    }
    if (!target.isActive) {
      return res.status(409).json({
        error: 'PROJECT_INACTIVE',
        code: 'PROJECT_INACTIVE',
        message: 'Target project is archived; re-activate before merging into it',
      });
    }

    // Refuse a self-merge: case-insensitive equal to the target's own
    // canonical name. The admin almost certainly meant to "Register" the
    // discovered name (POST /api/projects/resolve), not rewrite it onto
    // itself.
    if (sourceName.toLowerCase() === target.name.toLowerCase()) {
      return res.status(409).json({
        error: 'SAME_PROJECT',
        code: 'SAME_PROJECT',
        message: 'sourceName matches the target project name — nothing to merge',
      });
    }

    // Build the WHERE shape once so the dry-run and commit paths share it.
    // Case-insensitive: a discovery listed as "T-NAGAR" merges cleanly into
    // a curated "T-Nagar". Locked to projectId:null so we never re-stamp
    // rows that already point at the target (idempotent re-run).
    const whereShape = {
      projectId: null,
      projectName: { equals: sourceName, mode: 'insensitive' },
    };

    if (dryRun) {
      // Three independent COUNTs — no transaction needed for a read.
      const [dprCount, inspectionCount, boqCount] = await Promise.all([
        prisma.dPR.count({ where: whereShape }),
        prisma.inspectionRecord.count({ where: whereShape }),
        prisma.boqItem.count({ where: whereShape }),
      ]);
      return res.json({
        dryRun: true,
        target: { id: target.id, name: target.name },
        sourceName,
        counts: { dpr: dprCount, inspection: inspectionCount, boq: boqCount },
        total: dprCount + inspectionCount + boqCount,
      });
    }

    // Commit path. updateMany across three tables inside one transaction so
    // a partial failure rolls back the rest (e.g. BoqItem has a
    // unique(projectId, itemCode) constraint — a shared itemCode across
    // rows being merged could collide). The data shape rewrites BOTH
    // projectId AND projectName to the target's canonical name — the KPI
    // handler filters by exact projectName, so without the rewrite the
    // merged rows stay invisible to the dashboard.
    const dataShape = { projectId: target.id, projectName: target.name };
    const [dprRes, inspectionRes, boqRes] = await prisma.$transaction([
      prisma.dPR.updateMany({ where: whereShape, data: dataShape }),
      prisma.inspectionRecord.updateMany({ where: whereShape, data: dataShape }),
      prisma.boqItem.updateMany({ where: whereShape, data: dataShape }),
    ]);

    return res.json({
      dryRun: false,
      target: { id: target.id, name: target.name },
      sourceName,
      counts: {
        dpr: dprRes.count,
        inspection: inspectionRes.count,
        boq: boqRes.count,
      },
      total: dprRes.count + inspectionRes.count + boqRes.count,
    });
  } catch (err) {
    console.error('Projects merge-orphan-source error', {
      employeeHash: hashIdentifier(req.employeeId),
      prismaCode: err.code,
      message: err?.message?.split('\n')[0],
    });
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to merge orphan source' });
  }
}));

// ─── KPI handler ────────────────────────────────────────────────────────────
// One endpoint that returns the full dashboard payload for a project.
//
//   {
//     project: {...},
//     window: { from, to, days },
//     dpr: { submittedCount, pendingReviewCount, approvedCount, rejectedCount, draftCount },
//     inspections: { totalCount, openCount, byType: { ... } },
//     boqVariance: { itemsCount, totalContractValue, totalExecutedValue, variancePercent },
//     people: { onLeaveToday, pendingLeaveCount, overdueTrainingCount }
//   }
//
// `days` (query) controls the lookback window for activity counts.
// Defaults to 30. Capped at 365 — anything longer is a yearly roll-up and
// should hit the stats endpoints instead.
//
// Defensive wrapping per-roll-up: if a prisma.<model> call throws (e.g.
// because a sibling migration temporarily drops the table during deploy),
// the roll-up returns zeros and a `warning` is attached to the response.
// The dashboard must not 500 because one KPI source is unavailable — the
// other counts are still useful.
// DR-013: compute the half-open window [fromDay, toDayExclusive) in the
// ACS business timezone (Asia/Kolkata), reusing the canonical helper from
// lib/dateOnly.js — the same one attendance / dpr / inspection routes
// already use, so there is exactly one source of truth for "today".
//
// Why this used to be wrong: the previous inline computation picked the UTC
// calendar day from `new Date()`, so at 00:00–05:29 IST the upper bound
// became "yesterday in IST" (because UTC was still on the prior day). DPRs
// and inspections with `reportDate` stored as today's UTC midnight fell on
// the wrong side of the half-open range and the KPI tiles showed zero for
// the current IST day until 05:30 IST, when UTC's calendar day finally
// caught up. Reusing getTodayBusinessDate collapses both branches onto
// the IST calendar day.
//
// `fromDay` is `days` calendar days before `toDay` (subtracting whole
// days from a UTC-midnight Date is safe because UTC has no DST).
// `toDayExclusive` is the day after `toDay` at UTC midnight — the upper
// bound for the `lt` predicate that satisfies `gte fromDay && lt
// toDayExclusive`. Exported so tests can pin the IST boundary without
// having to mock `new Date()` globally.
function computeKpiWindow(now, days) {
  const toDay = getTodayBusinessDate(now); // UTC midnight of IST today
  const fromDay = new Date(toDay.getTime() - days * 24 * 60 * 60 * 1000);
  const toDayExclusive = new Date(toDay.getTime() + 24 * 60 * 60 * 1000);
  return { fromDay, toDayExclusive };
}

async function kpiHandler(req, res) {
  const prisma = getPrisma(req);
  if (!prisma) {
    return res.status(503).json({ error: 'Database unavailable', code: 'DB_UNAVAILABLE' });
  }

  // Window
  // Accept any integer 1..365. Values outside that range clamp to the
  // nearest bound (1 for 0/negative, 365 for over-large). NaN / missing
  // falls through to the default 30 — the dashboard's URL builder never
  // sends 0, and a typo'd URL that strips the param entirely is safer
  // as the default than as a 1-day window. The clamp is documented in
  // the response so a client can detect when its `days` was widened.
  const daysRaw = parseInt(req.query.days, 10);
  const days = Number.isFinite(daysRaw)
    ? Math.min(Math.max(daysRaw, 1), 365)
    : 30;
  const toDate = new Date(); // now (server clock)
  // DR-013: window is half-open over IST calendar days, not UTC.
  // See computeKpiWindow below for the rationale + the test that pins it.
  const { fromDay, toDayExclusive } = computeKpiWindow(toDate, days);

  // Resolve the project (or auto-discovered name).
  const result = await resolveProject(prisma, req.params.idOrName);
  if (result.kind === 'missing') {
    return res.status(404).json({ error: 'PROJECT_NOT_FOUND', code: 'PROJECT_NOT_FOUND', message: 'No project matches that id or name' });
  }
  const projectName = result.kind === 'project' ? result.project.name : result.name;

  const warnings = [];

  // ─── DPR roll-up ─────────────────────────────────────────────────────────
  // 5 mutually-exclusive counts: DRAFT, SUBMITTED, UNDER_REVIEW, APPROVED,
  // REJECTED. The KPI endpoint sums across the window; pendingReview is
  // SUBMITTED + UNDER_REVIEW (admin queue size).
  let dpr = {
    submittedCount: 0,
    pendingReviewCount: 0,
    approvedCount: 0,
    rejectedCount: 0,
    draftCount: 0,
  };
  try {
    const dprWhere = {
      projectName,
      reportDate: { gte: fromDay, lt: toDayExclusive },
    };
    const [draft, submitted, underReview, approved, rejected] = await Promise.all([
      prisma.dPR.count({ where: { ...dprWhere, status: 'DRAFT' } }),
      prisma.dPR.count({ where: { ...dprWhere, status: 'SUBMITTED' } }),
      prisma.dPR.count({ where: { ...dprWhere, status: 'UNDER_REVIEW' } }),
      prisma.dPR.count({ where: { ...dprWhere, status: 'APPROVED' } }),
      prisma.dPR.count({ where: { ...dprWhere, status: 'REJECTED' } }),
    ]);
    dpr = {
      submittedCount: submitted,
      pendingReviewCount: submitted + underReview,
      approvedCount: approved,
      rejectedCount: rejected,
      draftCount: draft,
    };
  } catch (err) {
    console.warn('Projects KPI — DPR roll-up failed', {
      projectName,
      prismaCode: err.code,
      message: err.message?.split('\n')[0],
    });
    warnings.push('dpr: ' + (err.message?.split('\n')[0] || 'unknown error'));
  }

  // ─── Inspections roll-up ─────────────────────────────────────────────────
  // totalCount is the full window. openCount is the ORG-wide OPEN count
  // (not windowed) — that's the "what's waiting on me" tile.
  // byType is grouped by inspectionType across the window. The frontend
  // surfaces the most common 5 + a "see all" link.
  let inspections = {
    totalCount: 0,
    openCount: 0,
    byType: {},
  };
  try {
    const baseWhere = { projectName };
    const [totalCount, openCount, grouped] = await Promise.all([
      prisma.inspectionRecord.count({
        where: { ...baseWhere, reportDate: { gte: fromDay, lt: toDayExclusive } },
      }),
      prisma.inspectionRecord.count({
        where: { ...baseWhere, status: 'OPEN' },
      }),
      prisma.inspectionRecord.groupBy({
        by: ['inspectionType'],
        where: { ...baseWhere, reportDate: { gte: fromDay, lt: toDayExclusive } },
        _count: { _all: true },
      }),
    ]);
    inspections = {
      totalCount,
      openCount,
      byType: grouped.reduce((acc, row) => {
        acc[row.inspectionType] = row._count._all;
        return acc;
      }, {}),
    };
  } catch (err) {
    console.warn('Projects KPI — Inspection roll-up failed', {
      projectName,
      prismaCode: err.code,
      message: err.message?.split('\n')[0],
    });
    warnings.push('inspections: ' + (err.message?.split('\n')[0] || 'unknown error'));
  }

  // ─── CubeTest roll-up (removed in Round-29) ──────────────────────────────
  // The standalone CubeTest feature was removed; cube testing is now
  // captured by the cube_casting / cube_testing InspectionRecord sub-types.
  // The shape below is kept so the KPI response contract holds; the
  // ProjectDashboard tile that consumed it was removed at the same time.
  const cubeTests = { dueSoonCount: 0, overdueCount: 0, passedCount: 0 };

  // ─── BOQ variance roll-up ────────────────────────────────────────────────
  // BoqItem has direct projectName. "Variance" = (totalExecuted -
  // totalContract) / totalContract. With no executed line yet the field
  // is 0 and variance is -100%; that's the spec's expected behaviour for
  // a brand-new project. Items without `amount` (rate * quantity) are
  // skipped — they will land as `amount` once the admin fills the rate.
  let boqVariance = {
    itemsCount: 0,
    totalContractValue: 0,
    totalExecutedValue: 0,
    variancePercent: 0,
  };
  try {
    const items = await prisma.boqItem.findMany({
      where: { projectName, isActive: true },
      select: { quantity: true, rate: true, amount: true },
    });
    let totalContract = 0;
    let totalExecuted = 0;
    for (const it of items) {
      const lineTotal = (Number(it.quantity) || 0) * (Number(it.rate) || 0);
      totalContract += lineTotal;
      totalExecuted += Number(it.amount) || 0;
    }
    const variancePercent = totalContract > 0
      ? Math.round(((totalExecuted - totalContract) / totalContract) * 10000) / 100
      : 0;
    boqVariance = {
      itemsCount: items.length,
      totalContractValue: totalContract,
      totalExecutedValue: totalExecuted,
      variancePercent,
    };
  } catch (err) {
    // [Phase-4 #2 diagnostic] surface the full Prisma error so we can
    // identify the missing column. P2022 normally carries
    // `err.meta = { column: '...' }`; some Prisma clients swallow the
    // first line of `err.message` and put the useful detail in `meta`.
    console.warn('Projects KPI — BOQ roll-up failed (tolerated)', {
      projectName,
      prismaCode: err.code,
      message: err.message?.split('\n').slice(0, 6).join('\n'), // first few lines, ANSI-safe
      meta: err.meta,
      fullMessage: err.message,
    });
    warnings.push('boqVariance: ' + (err.meta?.column ? `missing column ${err.meta.column}` : (err.message?.split('\n')[0] || 'unknown error')));
  }

  // ─── People roll-up ──────────────────────────────────────────────────────
  // ORG-wide counts. The "project" view of these is what the PM cares
  // about: "how many of my people are off today", "how many leave
  // requests are awaiting my approval", "how many training assignments
  // are past their due date". Cross-project by definition — a leave is
  // an HR concept, not a site concept.
  let people = {
    onLeaveToday: 0,
    pendingLeaveCount: 0,
    overdueTrainingCount: 0,
  };
  try {
    // DR-013: same UTC→IST correction as the DPR/Inspection window above.
    // A leave covering IST today must show as on-leave-today even before
    // 05:30 IST (when the UTC calendar day catches up to IST).
    const today = getTodayBusinessDate(toDate);
    const [onLeaveToday, pendingLeaveCount, overdueTrainingCount] = await Promise.all([
      prisma.leaveRequest.count({
        where: {
          status: 'APPROVED',
          startDate: { lte: today },
          endDate: { gte: today },
        },
      }),
      prisma.leaveRequest.count({ where: { status: 'PENDING' } }),
      prisma.trainingEnrollment.count({
        where: {
          status: 'OVERDUE',
        },
      }),
    ]);
    people = { onLeaveToday, pendingLeaveCount, overdueTrainingCount };
  } catch (err) {
    console.warn('Projects KPI — People roll-up failed (tolerated)', {
      prismaCode: err.code,
      message: err.message?.split('\n')[0],
    });
    warnings.push('people: ' + (err.message?.split('\n')[0] || 'unknown error'));
  }

  res.json({
    project: result.kind === 'project'
      ? serializeProject(result.project)
      : { name: result.name, isRegistered: false, isActive: true },
    window: {
      from: fromDay.toISOString().slice(0, 10),
      to: toDayExclusive.toISOString().slice(0, 10),
      days,
    },
    dpr,
    inspections,
    boqVariance,
    people,
    ...(warnings.length ? { warnings } : {}),
  });
}

// [N1] Phase A: export resolveProject so dpr.js and inspection.js can
// reuse the same idOrName → Project row resolution on POST/PATCH without
// duplicating the UUID regex + name-fallback logic. projects.js itself
// doesn't import either of those routes, so this is a one-way import
// (no require cycle). Same exposure contract as the route handlers below
// — anything that imports resolveProject gets the same semantics the
// /:idOrName endpoints honour.
//
// [DR-013] Phase A: export computeKpiWindow so the IST day-bucket
// boundary can be pinned by a unit test against the same function the
// kpiHandler uses. Keep the export list flat — no `module.exports =
// { ...router, ... }` merge, that would break existing default-import
// sites (projectRouter = require('./projects')).
module.exports = router;
module.exports.resolveProject = resolveProject;
module.exports.computeKpiWindow = computeKpiWindow;
