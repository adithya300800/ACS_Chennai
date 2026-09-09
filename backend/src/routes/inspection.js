// Inspection & Compliance Records — Round-12
//
// New resource that owns the 15 structured sub-work types formerly nested
// inside DPR.workEntries (material receipt, cube test, water quality,
// waterproofing inspection, villa inspection, NCR, safety violation, etc.).
// Each record has its own photos, FK back to its DPR (nullable — for
// filings on holidays / Sundays), and progresses through a workflow status.
//
// Auth model: same as DPR — any authenticated employee can create + view their
// own records; admins see all. Owner-only updates; status transitions for
// NCR / safety_violation are out of scope for this round (PMC expert
// recommended a full state machine — deferred per plan).

const express = require('express');
const router = express.Router();
const { requireAuth, requireFreshAdmin, requireAdmin } = require('../middleware/auth');
// DR-012: shared idempotency replay store. The Inspection POST is the
// canonical write surface SOL flagged — the create route previously had
// no request idempotency lookup, so a NETWORK_ERROR retry that landed
// after the original committed produced a duplicate InspectionRecord +
// duplicate admin notification fan-out. Same contract as dpr.js POST.
const { tryReplay: tryIdempotentReplay, recordSuccess: recordIdempotentSuccess } = require('../lib/idempotency');
const {
  generateReadSASUrl,
  CONTENT_TYPE_EXT,
} = require('../lib/blobStorage');
const { mapPrismaError, parseStrictISODate, parseISODateTime } = require('../lib/errors');
const { mountUploadRoutes } = require('../lib/uploadRoutes');
// [S3-7] Consumption half of LPR-012 — same contract as dpr.js. Photos
// must carry a CONFIRMED intent owned by the caller, and the created
// record stamps boundType/boundAt so the durable sweep leaves the blobs
// alone. See lib/uploadIntentBinding.js for the full rationale.
// [DR-006] The claim runs INSIDE the create transaction so a sweep racing
// the create rolls the record back (409) instead of committing evidence-less.
const {
  validatePhotoIntents,
  withRecordTransaction,
  assertPhotoIntentsBindable,
  bindPhotoIntentsTx,
  photoBindingLostResponse,
} = require('../lib/uploadIntentBinding');
const { encodeCursor, decodeCursor, InvalidCursorError } = require('../lib/cursor');
// DR-027: parseStrictISODate only validates calendar shape, so a well-formed
// future date used to persist. rejectIfFutureReportDate is the authority.
const { rejectIfFutureReportDate, assertNotFutureReportDate } = require('../lib/reportDate');
// LPR-013: dashboard "today" stats now derive from the IST business-day
// helper (matches how Attendance.date and DPR.reportDate are keyed) instead
// of UTC midnight of `new Date()`. Half-open [gte, lt) range is unchanged.
const { getTodayBusinessDate, getMonthRangeUtc, InvalidMonthRangeError } = require('../lib/dateOnly');
// Round-25: email fan-out for in-app notifications. Fire-and-forget —
// the helper swallows its own errors and never throws to the caller.
// Invoked inside the tx callback AFTER the notification row is created so
// the email leaves after (or concurrently with) the row commit; a failed
// tx rolls back the notification row AND the email send in-flight.
const { fanOutEmail } = require('../lib/notify');
// Round-26: admin-targeted fan-out for the POST /api/inspection → opened
// event. Admins get an immediate email per recipient, with per-admin
// preferences honoured. Guarded on `record.status === 'OPEN'` — admin-set
// non-OPEN statuses (e.g. ACKNOWLEDGED) are not the "first signal" admins
// need an email for.
const { fanOutToAdmins } = require('../lib/notify');
// hashIdentifier is used in error-log contexts (employeeHash field) below.
// The route previously used it without an import — caught by DR-005 tests
// failing in the inspectionHandleTransitionError path. Pinning the import
// here makes the late-running catch-all handler safe even when the route
// hits a non-_status error (e.g. unexpected throw from a tx callback).
const { hashIdentifier } = require('../lib/pii');
// [N1] Phase A: import resolveProject from the projects router so the
// POST/PATCH handlers can resolve either a projectId (preferred — fast
// PK lookup) or a projectName (free-text, looked up case-insensitively
// against the Project table). projects.js doesn't import inspection.js,
// so this is a one-way import (no require cycle). See dpr.js for the
// matching import + inline helper if a future refactor ever inverts
// the relationship.
const { resolveProject } = require('./projects');
// [N3] Phase E: shared drawing-link resolver. Same helper backs dpr.js
// so a cross-route contract drift is impossible.
const { resolveDrawingForReport } = require('../lib/drawingLink');

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function getPrisma(req) {
  return req.app.get('prisma');
}

// Mirror of the frontend SUB_WORK_TYPE_OPTIONS values in
// src/pages/portal/DprWorkTypes.jsx. Server is the source of truth — a
// client can't POST an unknown inspectionType and get past validation.
// `data` payload shape per type is defined by WORK_TYPE_FIELDS on the
// frontend; server-side we only enforce "must be a non-null object with
// no oversized string values" (full per-field validation is the
// frontend's job at submit time, plus shape-cap abuse prevention here).
const ALLOWED_INSPECTION_TYPES = new Set([
  // MATERIAL_RECEIPT
  'material_inspection', 'cement_receipt', 'steel_receipt',
  'bulk_materials', 'concrete_receipt', 'other_bulk_materials',
  // QUALITY_TESTING
  'water_quality', 'cube_casting', 'cube_testing',
  // SITE_INSPECTION
  'villa_inspection', 'day_activity_inspection', 'waterproofing_inspection',
  // EXCEPTIONS_SAFETY
  'major_deviation', 'ncr', 'safety_violation',
]);

// SOL-P2#13: human-readable labels for the enums that show up in
// notifications. Keep in sync with src/pages/portal/WorkTypes.jsx —
// frontend mirrors the same display name so users see one copy.
const INSPECTION_TYPE_LABELS = {
  material_inspection: 'Material Inspection',
  cement_receipt: 'Cement Receipt',
  steel_receipt: 'Steel Receipt (with MTC)',
  bulk_materials: 'Bulk Materials (ITP)',
  concrete_receipt: 'Concrete Receipt',
  other_bulk_materials: 'Other Bulk Materials',
  water_quality: 'Water Quality (ITP)',
  cube_casting: 'Cube Casting',
  cube_testing: 'Cube Testing',
  villa_inspection: 'Villa/Unit Inspection',
  day_activity_inspection: 'Day Activity Inspection',
  waterproofing_inspection: 'Waterproofing Inspection',
  major_deviation: 'Major Deviation',
  ncr: 'Non-Conformity Report',
  safety_violation: 'Safety Violation',
};
function labelizeInspectionType(t) {
  return INSPECTION_TYPE_LABELS[t] || String(t || '').replace(/_/g, ' ');
}

// SOL DR-005: add DRAFT so the frontend's "Save as Draft" button has a
// real target state. DRAFT is owner-only (an admin cannot create on behalf
// of a workflow in DRAFT — that would skip the legitimate notify path).
// DRAFT records do NOT trigger admin fan-out, do NOT appear in admin
// queues, and CAN be promoted to OPEN through the explicit
// POST /:id/submit transition (which DOES trigger the fan-out).
const ALLOWED_STATUSES = new Set([
  'DRAFT', 'OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS', 'PENDING_VERIFICATION', 'CLOSED', 'REJECTED',
]);

const ALLOWED_SEVERITIES = new Set(['MINOR', 'MAJOR', 'CRITICAL', 'NEAR_MISS', null]);

// DR-009: wire shape (Title Case from WorkTypes.jsx selector) → canonical
// column shape (UPPER_SNAKE_CASE on InspectionRecord.severity). Explicit
// table — no silent equivalents. Near Miss is intentionally NOT collapsed
// into MINOR: the whole point of offering it on the form is to distinguish
// a near-miss signal (no injury, no damage, but a real risk) from an actual
// minor event. If a wire value isn't in this map, the validation block
// below rejects it as SEVERITY_INVALID rather than defaulting to null.
const SEVERITY_TITLE_TO_CANONICAL = {
  'Near Miss': 'NEAR_MISS',
  'Minor': 'MINOR',
  'Major': 'MAJOR',
  'Critical': 'CRITICAL',
};
// DR-009: sub-types whose form selector writes severity into `data.severity`
// (not the wire top-level `severity` field). InspectionSubmit.jsx:873 sends
// `severity: null` at the wire top level, so the canonical column stays
// empty unless we copy from `data.severity`. Without this normalization the
// admin queue loses the severity signal entirely.
const SUBTYPES_WITH_STRUCTURED_SEVERITY = new Set([
  'safety_violation', 'major_deviation', 'ncr',
]);

// DR-009: per-subtype required-array contract. Mirrors the `required: true`
// flag on `type: 'checklist'` fields in WORK_TYPE_FIELDS
// (src/pages/portal/WorkTypes.jsx) — server is authoritative for the wire
// shape, frontend can only enforce UX rules. The Day Activity defect: a
// user checks and then unchecks every checklist option, producing
// `checklistItems: []`; the form's `if (field.required && !formData[field.name])`
// treats the empty array as truthy and lets Add+Submit succeed with Overall
// Status Pass. Server-side we require at least one entry. Keep this list
// small and explicit — if a new sub-type adds a required array, add it
// here at the same time as the WorkTypes.jsx edit.
const REQUIRED_ARRAY_FIELDS_BY_TYPE = {
  day_activity_inspection: ['checklistItems'],
};

// DR-009: nested action-status (WorkTypes.jsx:338 — 'Pending' | 'Under
// Investigation' | 'Action Taken' | 'Closed') is intentionally NOT mapped
// to the InspectionRecord.status state machine (OPEN / ACKNOWLEDGED /
// IN_PROGRESS / PENDING_VERIFICATION / CLOSED / REJECTED). The wire form
// captures the on-the-ground status of the safety action; the row's
// status column is admin-controlled through the dedicated /acknowledge,
// /close, /reject endpoints. Don't invent equivalences between the two —
// the actionStatus lives free-form inside `data.actionStatus` and is
// rendered verbatim on the admin queue card.

// Walk an arbitrary JSON object and cap every string value at `max` chars.
// Stops a malicious client from POSTing { data: { someField: '<2GB string>' } }
// and blowing up the row. Returns a list of violation paths so the error
// message is actionable (frontend can highlight the offending cell).
function findOversizedStrings(node, path, max, out = []) {
  if (node == null) return out;
  if (typeof node === 'string') {
    if (node.length > max) out.push(`${path} (${node.length} chars > ${max})`);
    return out;
  }
  if (Array.isArray(node)) {
    // Cap row count at 1000 and per-element string length — protects against
    // a giant `data.checklist` or `data.testResults` array.
    if (node.length > 1000) out.push(`${path} (array length ${node.length} > 1000)`);
    for (let i = 0; i < Math.min(node.length, 1000); i++) {
      findOversizedStrings(node[i], `${path}[${i}]`, max, out);
    }
    return out;
  }
  if (typeof node === 'object') {
    const keys = Object.keys(node);
    if (keys.length > 200) out.push(`${path} (object keys ${keys.length} > 200)`);
    for (const k of keys.slice(0, 200)) {
      findOversizedStrings(node[k], `${path}.${k}`, max, out);
    }
  }
  return out;
}

// All routes below require auth.
router.use(requireAuth);

// DR-021 (round-20): upload routes (sas-url + confirm-upload) are now
// shared with dpr.js via src/lib/uploadRoutes.js. The shared module
// owns the auth gate (mount after router.use(requireAuth)), MAX_PHOTO_SIZE
// ceiling, content-type allowlist, pendingUploads registry, and orphan-
// blob cleanup. Hardcoded container 'inspection-photos' — backend
// chooses, not the client.
mountUploadRoutes(router, {
  container: 'inspection-photos',
});

// ─── POST /api/inspection ────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const prisma = getPrisma(req);

  // DR-012: Idempotency-Key replay protection. Mirror of dpr.js POST
  // (round-10). The frontend's NETWORK_ERROR retry path in src/lib/api.js
  // re-sends the same payload — without this gate, the retry creates a
  // duplicate InspectionRecord, a duplicate notification row, and a
  // duplicate admin email fan-out. Replay returns the cached 201 with
  // the Idempotent-Replay header so the client can debug "did my second
  // click create a duplicate?" without a second notification.
  // Body-hash mismatch returns 409 IDEMPOTENCY_MISMATCH so a leaked key
  // cannot be used to probe arbitrary payloads against the cached slot
  // (DR-006 security pin).
  const idempotencyResult = tryIdempotentReplay(req);
  if (idempotencyResult && idempotencyResult.mismatch) {
    return res.status(409).json({
      error: 'Idempotency-Key was used for a different request body',
      code: 'IDEMPOTENCY_MISMATCH',
    });
  }
  if (idempotencyResult && idempotencyResult.replay) {
    res.setHeader('Idempotent-Replay', 'true');
    return res.status(idempotencyResult.cached.status).json(idempotencyResult.cached.body);
  }

  const {
    projectName, location, reportDate, weather, contractor,
    dprId, inspectionType, data, severity, status, photos = [],
    // N7 (round-28): optional BOQ link. Validated below so a foreign
    // or inactive item can never slip past the FK.
    boqItemId,
    // [N1] Phase A: nullable projectId FK. Accept EITHER projectId OR
    // projectName (preferring projectId when both supplied). Same shape
    // as the DPR POST handler — see dpr.js for the full rationale.
    projectId,
    // [N3] Phase E: optional drawing link. drawingRev is denormalized
    // at submit time so list views render the stamp without JOIN.
    drawingId, drawingRev,
  } = req.body || {};

  // N-4: compute requested status BEFORE the type-allowlist gate so the
  // DRAFT branch can relax the required-fields checks below. DRAFT is
  // "save for later" — accept the barest bones; OPEN is final publish
  // and keeps the strict contract.
  const requestedStatus = status === undefined ? 'OPEN' : status;

  // typeof guards (mirror dpr.js P1-2 — reject non-string types before Prisma).
  // DRAFT only requires projectName (or projectId) to be a non-empty
  // string; the rest can be filled in on resume.
  if ((typeof projectName !== 'string' || !projectName.trim()) &&
      (typeof projectId !== 'string' || !projectId.trim())) {
    return res.status(400).json({
      error: 'VALIDATION_ERROR',
      code: 'PROJECT_REQUIRED',
      message: 'Either projectId or projectName is required',
    });
  }
  if (requestedStatus !== 'DRAFT') {
    if (typeof location !== 'string' || !location.trim() ||
        typeof reportDate !== 'string') {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'projectName, location, reportDate required' });
    }
  }

  // [N1] Resolve the project to a real Project row (FK + canonical name).
  // Same resolution block as the DPR POST handler — projectId is
  // preferred (fast PK lookup), projectName falls back through
  // resolveProject() (UUID-or-name + case-insensitive). Discovered rows
  // (no curated Project row) are accepted: projectId stays NULL and
  // projectName gets the typed value, matching the legacy contract.
  let resolvedProject = null;
  if (typeof projectId === 'string' && projectId.trim()) {
    const p = await prisma.project.findUnique({ where: { id: projectId.trim() } });
    if (!p || !p.isActive) {
      return res.status(400).json({ error: 'PROJECT_NOT_FOUND', code: 'PROJECT_NOT_FOUND', message: 'Linked project does not exist or is inactive' });
    }
    resolvedProject = p;
  } else if (typeof projectName === 'string' && projectName.trim()) {
    const result = await resolveProject(prisma, projectName.trim());
    if (result.kind === 'missing') {
      return res.status(400).json({ error: 'PROJECT_NOT_FOUND', code: 'PROJECT_NOT_FOUND', message: 'No project matches that name' });
    }
    if (result.kind === 'project') {
      if (!result.project.isActive) {
        return res.status(400).json({ error: 'PROJECT_INACTIVE', code: 'PROJECT_INACTIVE', message: 'Project is archived (isActive=false)' });
      }
      resolvedProject = result.project;
    }
    // kind === 'discovered' → resolvedProject stays null.
  }
  const canonicalProjectName = resolvedProject ? resolvedProject.name : (typeof projectName === 'string' ? projectName.trim() : '');
  const resolvedProjectId = resolvedProject ? resolvedProject.id : null;

  // Length caps (mirror dpr.js MAX map).
  const MAX = { projectName: 200, location: 200, weather: 80, contractor: 200 };
  for (const [k, cap] of Object.entries(MAX)) {
    if (req.body[k] != null && typeof req.body[k] === 'string' && req.body[k].length > cap) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: `${k} exceeds ${cap} chars` });
    }
  }

  // inspectionType allowlist — server is source of truth.
  // N-4: a DRAFT may legitimately have no inspectionType yet (the
  // employee just typed a project name and wants to come back later).
  // OPEN rows still require a real type because they enter the review
  // workflow and the routing/admin fan-out needs to know what it is.
  if (requestedStatus === 'DRAFT') {
    if (inspectionType !== null && inspectionType !== undefined
        && !ALLOWED_INSPECTION_TYPES.has(inspectionType)) {
      return res.status(422).json({
        error: `inspectionType must be one of: ${[...ALLOWED_INSPECTION_TYPES].join(', ')}`,
        code: 'INSPECTION_TYPE_INVALID',
        allowed: [...ALLOWED_INSPECTION_TYPES],
      });
    }
  } else if (!inspectionType || !ALLOWED_INSPECTION_TYPES.has(inspectionType)) {
    return res.status(422).json({
      error: `inspectionType must be one of: ${[...ALLOWED_INSPECTION_TYPES].join(', ')}`,
      code: 'INSPECTION_TYPE_INVALID',
      allowed: [...ALLOWED_INSPECTION_TYPES],
    });
  }

  // date validation — same strict YYYY-MM-DD parser as dpr.js.
  // DRAFT may have no date yet; OPEN must have a strict YYYY-MM-DD.
  let dateUTC = null;
  if (reportDate) {
    const dateParsed = parseStrictISODate(reportDate);
    if (!dateParsed.ok) {
      return res.status(400).json({ error: 'INVALID_REPORT_DATE', message: 'reportDate must be a valid YYYY-MM-DD date' });
    }
    dateUTC = dateParsed.date;
  }

  // DR-027: mirror of the dpr.js create guard. A future-dated inspection sits
  // in the admin queue (OPEN) for a site visit that hasn't happened, and
  // back-fills the linked DPR's day bucket. Admins may override (audited).
  if (rejectIfFutureReportDate(req, res, dateUTC, 'inspection.create')) return;

  // severity — nullable, allowlist
  if (severity !== undefined && severity !== null && !ALLOWED_SEVERITIES.has(severity)) {
    return res.status(422).json({
      error: `severity must be one of: MINOR, MAJOR, CRITICAL`,
      code: 'SEVERITY_INVALID',
    });
  }

  // DR-004 (round-20): owner-create is restricted to status OPEN. The
  // other 5 statuses (ACKNOWLEDGED, IN_PROGRESS, PENDING_VERIFICATION,
  // CLOSED, REJECTED) are admin-only workflow states reached through
  // /acknowledge, /close, /reject, and the bulk-review endpoint. The
  // previous implementation accepted ANY of the 6 — an employee could
  // POST an inspection with `status: 'CLOSED'` and skip the entire
  // admin review queue.
  //
  // Admins creating inspections on behalf of a workflow (rare, but
  // legitimate for back-filling NCRs) use the same route with the
  // admin status explicitly — gated below by req.isAdmin.
  // N-4: `requestedStatus` is now declared earlier (above the type
  // allowlist gate) so the DRAFT branch can relax field requirements.
  if (!ALLOWED_STATUSES.has(requestedStatus)) {
    return res.status(422).json({
      error: `status must be one of: ${[...ALLOWED_STATUSES].join(', ')}`,
      code: 'STATUS_INVALID',
    });
  }
  // SOL DR-005: DRAFT is owner-allowed without an admin re-read. The
  // rationale is the inverse of the S3-9 admin gate — DRAFT is the
  // "I am not ready to publish" state, which is the OPPOSITE of what an
  // admin trying to skip the queue would request. Admins still cannot
  // create a DRAFT on an employee's behalf because that would hide work
  // from the queue, but the cheaper no-DB-read path is safe here.
  if (requestedStatus !== 'OPEN' && requestedStatus !== 'DRAFT') {
    // S3-9 (round-27): do NOT trust req.isAdmin from the JWT. A user demoted
    // from admin via the team page keeps a valid token for up to
    // JWT_TTL_MINUTES; trusting the cached claim would let them POST a
    // CLOSED inspection and skip the review queue for that window.
    // Inline DB re-read mirrors the assertFreshAdmin pattern at
    // training.js:716. Cost: one indexed PK read per non-OPEN POST.
    const fresh = await prisma.employee.findUnique({
      where: { id: req.employeeId },
      select: { isAdmin: true },
    });
    if (!fresh || !fresh.isAdmin) {
      return res.status(403).json({
        error: 'Only admins can create inspections in a non-OPEN status',
        code: 'STATUS_ADMIN_ONLY',
        currentStatus: requestedStatus,
      });
    }
  }
  const finalStatus = requestedStatus;
  // DR-009: canonical severity used at write time. The wire top-level
  // `severity` field is already allowlist-validated above (line 325);
  // this local mirrors it so the data-block normalization can promote
  // `data.severity` (Title Case from the form selector) into the same
  // column without mutating the const destructured from req.body.
  let normalisedSeverity = severity;

  // data — must be a non-null object; cap string values to prevent abuse.
  // Per-field validation (required-ness) is the frontend's job (mirrors how
  // DPR.workEntries was handled pre-refactor).
  // N-4: DRAFT rows can have null data (no workEntry yet). OPEN rows
  // require a JSON object so the inspection is renderable on the admin
  // queue.
  // DR-008: normalize a DRAFT's `data: null` to `{}` so downstream reads
  // (admin queue render, detail page JSON.parse) don't have to special-case
  // null. The wire shape `{ data: null }` is the barest-bones "Save as
  // Draft" payload; storing it as a real object keeps the schema uniform.
  if (requestedStatus === 'DRAFT') {
    if (data !== null && data !== undefined
        && (typeof data !== 'object' || Array.isArray(data))) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'data must be a JSON object or null' });
    }
  } else if (data == null || typeof data !== 'object' || Array.isArray(data)) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'data must be a JSON object' });
  }
  if (data != null) {
    const oversized = findOversizedStrings(data, 'data', 5000);
    if (oversized.length) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: `data has oversized string fields: ${oversized.slice(0, 3).join('; ')}`,
        field: 'data',
      });
    }

    // DR-009: server-side enforcement of required-array fields. The
    // frontend validates each field, but a checked-then-unchecked checklist
    // (e.g. Day Activity `checklistItems: []`) used to slip past the form
    // because the empty array is truthy in WorkEntryForm.jsx's
    // `if (field.required && !formData[field.name])` check. Pin the
    // contract server-side so an empty required array rejects with a
    // actionable field path. DRAFT is exempt — the barest bones (just a
    // project name) is the whole point of "Save as Draft".
    if (requestedStatus !== 'DRAFT') {
      const requiredArrays = REQUIRED_ARRAY_FIELDS_BY_TYPE[inspectionType] || [];
      for (const fieldName of requiredArrays) {
        const arr = data[fieldName];
        if (!Array.isArray(arr) || arr.length === 0) {
          return res.status(400).json({
            error: 'VALIDATION_ERROR',
            code: 'REQUIRED_FIELD_EMPTY',
            message: `${fieldName} must contain at least one entry`,
            field: `data.${fieldName}`,
          });
        }
      }
    }

    // DR-009: normalize wire-shaped severity into the canonical column.
    // The form selector on WorkTypes.jsx:331 emits Title Case ('Near Miss',
    // 'Minor', 'Major', 'Critical') into `data.severity`. InspectionSubmit
    // (line 873) always sends `severity: null` at the wire top level, so
    // without this copy the canonical column stays NULL and the admin
    // queue loses the severity signal. Copy via SEVERITY_TITLE_TO_CANONICAL
    // (explicit map — no silent defaults); reject anything outside the
    // known set so a typo like 'Critcal' doesn't silently downgrade to
    // null and lose the signal entirely. Wire top-level `severity` wins
    // when both are present (it's the explicit signal); otherwise the
    // mapped value flows through `normalisedSeverity`.
    if (
      SUBTYPES_WITH_STRUCTURED_SEVERITY.has(inspectionType)
      && typeof data.severity === 'string'
      && data.severity.length > 0
    ) {
      const mapped = SEVERITY_TITLE_TO_CANONICAL[data.severity];
      if (mapped === undefined) {
        return res.status(422).json({
          error: `data.severity not recognized: ${data.severity}`,
          code: 'SEVERITY_INVALID',
          allowed: Object.keys(SEVERITY_TITLE_TO_CANONICAL),
        });
      }
      // Wire top-level `severity` was null but `data.severity` mapped
      // cleanly — promote it. If both are present, the wire top level
      // wins (it's the explicit signal). If both are null, leave null.
      if (normalisedSeverity === null || normalisedSeverity === undefined) {
        normalisedSeverity = mapped;
      }
    }
  }

  // dprId — optional, but if provided must be a valid UUID that exists.
  // The DPR doesn't have to belong to the submitter — site engineers may file
  // an inspection against another engineer's DPR (e.g. NCR during weekend).
  // DR-018/S4-B (audit): previously we also built a `dprConnect = { connect: … }`
  // object for a Prisma nested-write path, but the actual create (further down)
  // persists the FK via the scalar `dprId: dprId || null` field. The connect
  // object was dead — removed to keep the validation and the write aligned.
  if (dprId !== undefined && dprId !== null && dprId !== '') {
    if (typeof dprId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(dprId)) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'dprId must be a UUID' });
    }
    const exists = await prisma.dPR.findUnique({ where: { id: dprId }, select: { id: true } });
    if (!exists) {
      return res.status(404).json({ error: 'DPR_NOT_FOUND', message: 'Linked DPR does not exist' });
    }
  }

  // N7 (round-28): BOQ link validation. Same contract as DPR — must
  // exist + be active + match projectName (the create payload's
  // projectName is the authoritative target; the BOQ must belong to
  // it). PATCH uses the in-flight fields.projectName fallback (see
  // below).
  let normalisedBoqItemId = null;
  if (boqItemId !== undefined && boqItemId !== null && boqItemId !== '') {
    if (typeof boqItemId !== 'string') {
      return res.status(400).json({ error: 'VALIDATION_ERROR', code: 'VALIDATION_ERROR', message: 'boqItemId must be a string' });
    }
    const boq = await prisma.boqItem.findUnique({ where: { id: boqItemId }, select: { id: true, projectName: true, isActive: true } });
    if (!boq) {
      return res.status(400).json({ error: 'BOQ_ITEM_NOT_FOUND', code: 'BOQ_ITEM_NOT_FOUND', message: 'Linked BOQ item does not exist' });
    }
    if (!boq.isActive) {
      return res.status(400).json({ error: 'BOQ_ITEM_INACTIVE', code: 'BOQ_ITEM_INACTIVE', message: 'Linked BOQ item is archived (isActive=false)' });
    }
    if (boq.projectName.trim() !== canonicalProjectName) {
      return res.status(400).json({ error: 'BOQ_PROJECT_MISMATCH', code: 'BOQ_PROJECT_MISMATCH', message: 'Linked BOQ item belongs to a different projectName' });
    }
    normalisedBoqItemId = boqItemId;
  }

  // [N3] Phase E: optional drawing link. Same resolution contract as the
  // DPR POST handler — drawing must exist + belong to the same project;
  // drawingRev is denormalized to the row's current revision when the
  // client doesn't override it.
  const drawingResolution = await resolveDrawingForReport({
    prisma,
    drawingId: drawingId === '' ? null : drawingId,
    drawingRev,
    resolvedProjectId,
  });
  if (drawingResolution.error) {
    if (typeof drawingResolution.error === 'string') {
      return res.status(400).json({ error: 'VALIDATION_ERROR', code: 'VALIDATION_ERROR', message: drawingResolution.error });
    }
    return res.status(drawingResolution.error.status).json(drawingResolution.error.body);
  }
  const resolvedDrawingId = drawingResolution.drawingId ?? null;
  const resolvedDrawingRev = drawingResolution.drawingRev ?? null;

  // photos — same shape as DPR photos but container must be 'inspection-photos'.
  if (!Array.isArray(photos) || photos.length > 50) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'photos must be an array (max 50)' });
  }
  for (let i = 0; i < photos.length; i++) {
    const p = photos[i];
    if (!p || typeof p !== 'object') {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: `photos[${i}] must be an object` });
    }
    if (typeof p.ulid !== 'string' || !/^[0-9A-HJKMNP-TV-Z]{26}$/i.test(p.ulid)) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: `photos[${i}].ulid invalid` });
    }
    if (p.container !== 'inspection-photos') {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: `photos[${i}].container must be inspection-photos` });
    }
    if (!CONTENT_TYPE_EXT[p.contentType]) {
      return res.status(400).json({ error: 'INVALID_CONTENT_TYPE', message: `photos[${i}].contentType invalid` });
    }
    const sb = Number(p.sizeBytes);
    if (!Number.isFinite(sb) || sb <= 0 || sb > 10 * 1024 * 1024) {
      return res.status(413).json({ error: 'PHOTO_TOO_LARGE', message: `photos[${i}].sizeBytes must be 1..${10 * 1024 * 1024}` });
    }
    if (typeof p.filename !== 'string' || p.filename.length > 255 || p.filename.includes('\0') || p.filename.includes('..')) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: `photos[${i}].filename invalid` });
    }
    if (p.takenAt !== undefined && p.takenAt !== null) {
      const td = parseISODateTime(p.takenAt);
      if (td === null) return res.status(400).json({ error: 'VALIDATION_ERROR', message: `photos[${i}].takenAt invalid` });
    }
  }

  // [S3-7] Mirror of the dpr.js gate: every photo must map to a CONFIRMED
  // upload intent owned by THIS employee. The loop above only validates
  // the ulid's shape, so without this a client could attach a fabricated
  // ulid — or another employee's — to an inspection record.
  const intentErr = await validatePhotoIntents({
    prisma,
    employeeId: req.employeeId,
    photos,
    context: 'inspection.create',
  });
  if (intentErr) return res.status(intentErr.status).json(intentErr.body);

  try {
    // [DR-006] Same contract as dpr.js: re-assert the intents, create the
    // record + photo rows, and claim the intents — all in one transaction.
    const record = await withRecordTransaction(prisma, 'inspectionRecord', async (db) => {
      await assertPhotoIntentsBindable({ tx: db, employeeId: req.employeeId, photos });

      const created = await db.inspectionRecord.create({
        data: {
          // [N1] projectId FK + denormalized projectName — mirror of the
          // DPR POST handler. canonicalProjectName is the Project row's
          // name when curated, or the typed name when discovered;
          // projectId is NULL in the discovered case.
          projectId: resolvedProjectId,
          projectName: canonicalProjectName,
          location: location.trim(),
          reportDate: dateUTC,
          weather: weather || null,
          contractor: contractor || null,
          dprId: dprId || null,
          inspectionType,
          // DR-008: standardise empty DRAFT data as {} rather than null so
          // downstream readers don't have to special-case null. OPEN rows
          // already rejected null above, so this only affects DRAFT.
          data: data == null ? {} : data,
          status: finalStatus,
          severity: normalisedSeverity || null,
          submittedById: req.employeeId,
          // N7 (round-28): BOQ link — null when omitted so the FK
          // column is NULL (the row stays unlinked).
          boqItemId: normalisedBoqItemId,
          // [N3] Phase E: drawing link. Null when omitted so the FK
          // column is NULL. drawingRev is denormalized at submit time.
          drawingId: resolvedDrawingId,
          drawingRev: resolvedDrawingRev,
          photos: {
            create: photos.map(p => ({
              ulid: p.ulid,
              container: p.container,
              filename: p.filename,
              contentType: p.contentType,
              sizeBytes: p.sizeBytes,
              caption: p.caption || null,
              location: p.location || null,
              takenAt: p.takenAt ? new Date(p.takenAt) : null,
            })),
          },
        },
        include: {
          photos: true,
          submittedBy: { select: { id: true, name: true, email: true } },
          dpr: { select: { id: true, reportDate: true, projectName: true } },
          // N7 (round-28): BOQ summary on the create response.
          boqItem: { select: { id: true, itemCode: true, description: true, unit: true } },
          // [N1] Project summary on the create response, mirror of DPR POST.
          project: { select: { id: true, name: true, code: true } },
          // [N3] Drawing summary on the create response, mirror of DPR POST.
          drawing: { select: { id: true, drawingNumber: true, revision: true, status: true } },
        },
      });

      // [S3-7 + DR-006] Claim the intents in the SAME transaction as the
      // create. A short count throws, rolling the record and its photo rows
      // back, and the catch below turns it into 409 PHOTO_BINDING_LOST.
      await bindPhotoIntentsTx({
        tx: db,
        employeeId: req.employeeId,
        photos,
        boundType: 'inspection',
        recordId: created.id,
      });

      return created;
    });

    res.status(201).json(record);

    // DR-012: persist the success under (employeeId, idempotencyKey)
    // so a same-key retry within the TTL window returns the cached
    // body instead of re-running the side effects (record + photos +
    // bind-claims + admin notification fan-out). MUST run BEFORE the
    // admin fan-out below — otherwise a retry that lands while the
    // fan-out is still in flight would re-queue a duplicate
    // notification email.
    if (idempotencyResult && idempotencyResult.key) {
      recordIdempotentSuccess(req, 201, record, req.body);
    }

    // Round-26: fire admin-targeted fan-out for newly-OPENED inspections.
    // Guard on `record.status === 'OPEN'` — admin-set non-OPEN statuses
    // (e.g. ACKNOWLEDGED) are not the "first signal" admins need an email
    // for. SOL DR-005: DRAFT is the explicit "do not notify yet" state,
    // so the fan-out stays silent. The owner promotes DRAFT → OPEN through
    // POST /:id/submit (separate transition) — that path fires the fan-out.
    // Best-effort: any error is swallowed inside the helper.
    if (record.status === 'OPEN') {
      try {
        await fanOutToAdmins(
          {
            type: 'ADMIN_INSPECTION_OPENED',
            message: `New inspection opened by ${record.submittedBy?.name || 'an employee'}: ${record.inspectionType || 'inspection'}`,
            meta: {
              employeeName: record.submittedBy?.name || 'an employee',
              recordTitle: canonicalProjectName || record.inspectionType || 'an inspection',
              inspectionType: record.inspectionType || '',
              inspectionId: record.id,
            },
          },
          prisma,
        );
      } catch (adminErr) {
        console.error('Inspection admin fan-out error', {
          inspectionId: record.id,
          message: adminErr?.message?.split('\n')[0],
        });
      }
    }
  } catch (err) {
    // [DR-006] Lost photo claim → 409, not 500. The transaction rolled
    // back, so there is no half-saved record; the client re-uploads.
    const bindingLost = photoBindingLostResponse(err);
    if (bindingLost) {
      console.warn('Inspection create rolled back — photo binding lost', {
        employeeHash: hashIdentifier(req.employeeId),
        expected: err.expected,
        bound: err.bound,
      });
      return res.status(bindingLost.status).json(bindingLost.body);
    }
    console.error('Inspection create error', {
      employeeHash: hashIdentifier(req.employeeId),
      prismaCode: err.code,
      message: err.message?.split('\n')[0],
    });
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to create inspection record' });
  }
});

// ─── GET /api/inspection ────────────────────────────────────────────────────
// Supports filters: dprId, reportDate (YYYY-MM-DD or full ISO), from/to
// (YYYY-MM-DD range — DR-028), inspectionType, status, severity, cursor
// (base64(reportDate|id)), limit (max 100).
//
// Non-admins are restricted to their own records; admins see all unless
// `my=true` is passed.
//
// DR-028: the admin dashboard has always sent `from`/`to` range
// parameters, but the route previously ignored them — `filterFrom`/`filterTo`
// in InspectionDashboard.jsx were dead UI. We now parse them through the
// same `parseStrictISODate` helper as the single-day `reportDate` filter
// and merge them as an inclusive `gte`/`lte` range (calendar-day
// semantics on @db.Date — same as the leave admin queue).
//
// Filter precedence:
//   1. `reportDate` (exact day) → exclusive range over the day
//   2. `from` + `to` (inclusive range)
//   3. `from` only / `to` only (one-sided open range)
//
// Sending both `reportDate` and `from`/`to` returns the intersection
// (record-date matches BOTH), which is the most useful semantics — a
// caller looking at "exactly Sept 4 within the Sept 1..Sept 7 window"
// gets that record and nothing else.
router.get('/', asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  const { cursor, limit = '20', dprId, reportDate, from, to, inspectionType, status, severity, my, month, projectId, projectName: projectNameFilter } = req.query;

  const take = Math.min(parseInt(limit) || 20, 100);

  // Cursor: base64url(JSON.stringify({ date: 'YYYY-MM-DD', id })).
  // DR-008: use the unified cursor codec so encoder + decoder agree.
  let cursorWhere = {};
  if (cursor) {
    let decoded;
    try {
      decoded = decodeCursor(cursor);
    } catch (e) {
      if (e instanceof InvalidCursorError) {
        return res.status(400).json({ error: 'INVALID_CURSOR', message: e.message || 'Cursor is malformed or expired' });
      }
      return res.status(400).json({ error: 'INVALID_CURSOR', message: 'Cursor could not be decoded' });
    }
    cursorWhere = {
      OR: [
        { reportDate: { lt: decoded.date } },
        { reportDate: decoded.date, id: { lt: decoded.id } },
      ],
    };
  }

  // reportDate filter — accept exact YYYY-MM-DD or full ISO; falls back to Date.parse.
  let reportDateFilter = undefined;
  if (reportDate) {
    const strict = parseStrictISODate(reportDate);
    if (strict.ok) {
      // Match the whole day in UTC.
      const next = new Date(strict.date);
      next.setUTCDate(next.getUTCDate() + 1);
      reportDateFilter = { gte: strict.date, lt: next };
    } else {
      const dt = new Date(reportDate);
      if (isNaN(dt.getTime())) {
        return res.status(400).json({ error: 'INVALID_REPORT_DATE', message: 'reportDate must be a valid date' });
      }
      reportDateFilter = dt;
    }
  }

  // DR-028: from/to range filter. Both bounds are inclusive calendar-day
  // matches against the @db.Date `reportDate` column (UTC midnight).
  // Each bound is parsed independently so a missing bound means "no
  // constraint on that side". A reversed range (from > to) is a client
  // bug — return 400 rather than silently returning an empty set.
  let rangeFilter = undefined;
  if (from || to) {
    let fromDate = null;
    let toDate = null;
    if (from !== undefined) {
      const parsed = parseStrictISODate(String(from));
      if (!parsed.ok) {
        return res.status(400).json({
          error: 'from must be a valid YYYY-MM-DD',
          code: 'INVALID_FROM_DATE',
        });
      }
      fromDate = parsed.date;
    }
    if (to !== undefined) {
      const parsed = parseStrictISODate(String(to));
      if (!parsed.ok) {
        return res.status(400).json({
          error: 'to must be a valid YYYY-MM-DD',
          code: 'INVALID_TO_DATE',
        });
      }
      toDate = parsed.date;
    }
    if (fromDate && toDate && fromDate > toDate) {
      return res.status(400).json({
        error: 'from must be on or before to',
        code: 'INVALID_DATE_RANGE',
      });
    }
    rangeFilter = {};
    if (fromDate) rangeFilter.gte = fromDate;
    if (toDate) rangeFilter.lte = toDate;
  }

  // Round-27: `month=YYYY-MM` query shortcut on the list endpoint. Same
  // contract as dpr.js — half-open [gte, lt) window aligned to the IST
  // business calendar (see backend/src/lib/dateOnly.js). Combining `month`
  // with `from`/`to` would expand the same `reportDate` predicate twice
  // and risk an unexpected intersection, so we reject explicitly with 400.
  // (Also rejected by dpr.js via MONTH_AND_RANGE_CONFLICT for symmetry.)
  if (month && (from || to)) {
    return res.status(400).json({
      error: 'month cannot be combined with from/to',
      code: 'MONTH_AND_RANGE_CONFLICT',
    });
  }
  if (month) {
    let monthRange;
    try {
      monthRange = getMonthRangeUtc(String(month));
    } catch (e) {
      if (e instanceof InvalidMonthRangeError) {
        return res.status(400).json({ error: e.message, code: 'INVALID_MONTH' });
      }
      throw e;
    }
    // Same shape as a manually-typed from/to range so the existing
    // mergedDate logic below (which AND-merges reportDate + rangeFilter)
    // picks it up without a separate branch.
    rangeFilter = { gte: monthRange.startDate, lt: monthRange.endDate };
  }

  try {
    const employee = await prisma.employee.findUnique({ where: { id: req.employeeId } });
    const isAdmin = employee && employee.isAdmin;
    const restrictToSelf = !isAdmin || my === 'true';

    // DR-028: merge `reportDate` (single day, half-open [gte,lt)) and
    // `from`/`to` (inclusive range, [gte,lte]) into one `reportDate`
    // clause by combining per-bound keys. Prisma's per-field filter
    // AND-combines its members, so we just take the tighter bound on
    // each side:
    //   gte = max(reportDateFilter.gte, rangeFilter.gte)  (whichever is
    //         larger — both must be satisfied)
    //   lt  = reportDateFilter.lt  (single-day only)
    //   lte = rangeFilter.lte       (range only)
    // When neither is supplied, `reportDate` is omitted entirely.
    const mergedDate = {};
    if (reportDateFilter) {
      if (reportDateFilter.gte) mergedDate.gte = reportDateFilter.gte;
      if (reportDateFilter.lt) mergedDate.lt = reportDateFilter.lt;
      if (reportDateFilter.equals) mergedDate.equals = reportDateFilter.equals;
    }
    if (rangeFilter) {
      if (rangeFilter.gte && (!mergedDate.gte || rangeFilter.gte > mergedDate.gte)) {
        mergedDate.gte = rangeFilter.gte;
      }
      if (rangeFilter.lte) mergedDate.lte = rangeFilter.lte;
      // Round-27: half-open `lt` (exclusive upper bound) — currently set
      // only by `?month=` (rangeFilter.lt) and by single-day `reportDate`
      // (reportDateFilter.lt). When both are present, take the tighter
      // one so the merged window can never be wider than either source.
      if (rangeFilter.lt && (!mergedDate.lt || rangeFilter.lt < mergedDate.lt)) {
        mergedDate.lt = rangeFilter.lt;
      }
    }
    const reportDateWhere = Object.keys(mergedDate).length > 0 ? mergedDate : undefined;

    const where = {
      ...(restrictToSelf ? { submittedById: req.employeeId } : {}),
      ...(dprId ? { dprId } : {}),
      ...(inspectionType ? { inspectionType } : {}),
      ...(status ? { status } : {}),
      ...(severity ? { severity } : {}),
      ...(reportDateWhere ? { reportDate: reportDateWhere } : {}),
      // [N1] projectId FK filter on the list endpoint — mirror of the
      // DPR list. projectName (free-text) is left out by default; the
      // KPI endpoint still groups on the denormalized column. If a
      // caller really needs a name filter, they can resolve via the
      // projects router first.
      ...(projectId ? { projectId } : {}),
      ...(cursor ? cursorWhere : {}),
    };

    const records = await prisma.inspectionRecord.findMany({
      where,
      include: {
        photos: { select: { id: true, caption: true, contentType: true, ulid: true, container: true } },
        submittedBy: { select: { id: true, name: true, email: true } },
        dpr: { select: { id: true, reportDate: true, projectName: true } },
        // N7 (round-28): BOQ summary on the list endpoint so admin
        // queue cards can render the linked item code without a
        // per-row roundtrip.
        boqItem: { select: { id: true, itemCode: true, description: true, unit: true } },
        // [N1] Project summary on the list endpoint — admin queue cards
        // can render the FK target without a per-row roundtrip.
        project: { select: { id: true, name: true, code: true } },
        // [N3] Drawing summary on the list endpoint.
        drawing: { select: { id: true, drawingNumber: true, revision: true, status: true } },
      },
      orderBy: [{ reportDate: 'desc' }, { id: 'desc' }],
      take: take + 1,
    });

    const hasMore = records.length > take;
    const items = hasMore ? records.slice(0, -1) : records;
    const lastItem = items[items.length - 1];
    // DR-008: route the encoder through the unified cursor codec so the
    // wire format round-trips through the same decoder.
    let nextCursor = null;
    if (hasMore && lastItem && lastItem.reportDate != null && lastItem.id) {
      try {
        nextCursor = encodeCursor(lastItem.reportDate, lastItem.id);
      } catch (e) {
        console.error('Inspection cursor encode failed', { err: e.message });
        nextCursor = null;
      }
    }

    res.setHeader('X-Total-Count', items.length);
    res.setHeader('X-Has-More', hasMore ? 'true' : 'false');
    res.json({ inspections: items, nextCursor });
  } catch (err) {
    console.error('Inspection list error', {
      prismaCode: err.code,
      message: err.message?.split('\n')[0],
    });
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to fetch inspections' });
  }
}));

// ─── GET /api/inspection/stats ──────────────────────────────────────────────
// DR-029 (round-20): explicit aggregate counts for the admin inspection
// dashboard. Mirrors the /api/dpr/stats shape so the frontend treats both
// endpoints uniformly.
//
// Before this endpoint existed, InspectionDashboard sent three requests
// with limit=1 and used response length as the count. That meant "Open",
// "Filed Today", and "Closed" could never display more than 1, and "Total
// Visible" never more than 2. Same anti-pattern as DPR but worse because
// limit=1 made it obviously broken at scale (admin at the live portal
// testing round-19 reported "the dashboard says 1 open inspection when
// there are clearly more in the queue").
//
// Six targeted COUNT queries against indexed columns (reportDate, status),
// all in parallel. Admin-only via requireFreshAdmin (falls back to
// requireAdmin in older builds). See docs/dashboard-metrics.md.
//
// LIVE-DISCOVERED (round-20): /stats MUST be registered BEFORE /:id or
// Express routes GET /api/inspection/stats through :id with id='stats',
// triggering a prisma.inspectionRecord.findUnique miss and a 404. Mirror
// of the dpr.js fix above.
const inspectionStatsAdminGuard = requireFreshAdmin || requireAdmin;

router.get('/stats', inspectionStatsAdminGuard, asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  if (!prisma) {
    return res.status(503).json({ error: 'Database unavailable', code: 'DB_UNAVAILABLE' });
  }

  // LPR-013: same IST-day window convention as /api/dpr/stats — derive
  // "today" via getTodayBusinessDate() so the bucket lands on the correct
  // calendar day for an India-based workforce. The previous
  // `setUTCHours(0,0,0,0)` was wrong: between 00:00 and 05:29 IST an
  // inspection filed in IST was being counted under yesterday's UTC bucket
  // and between 18:30 UTC and midnight UTC (= 00:00–05:30 IST the next day)
  // a tomorrow-filed IST inspection was already counted under today.
  // reportDate is @db.Date so { gte: today, lt: tomorrow } covers the full
  // day; updatedAt (used by closedToday) is a DateTime column but we want
  // the same wall-clock-day definition, so we share the helper.
  const startOfToday = getTodayBusinessDate();
  const endOfToday = new Date(startOfToday);
  endOfToday.setUTCDate(endOfToday.getUTCDate() + 1);

  const [
    openNow,
    filedToday,
    closedToday,
    acknowledged,
    pendingReview,
    totalActive,
  ] = await Promise.all([
    // openNow: every OPEN record across the org (no date window — this is
    // the "how big is the current queue" tile).
    prisma.inspectionRecord.count({ where: { status: 'OPEN' } }),
    // filedToday: any record whose reportDate is today, regardless of
    // status. "Filed Today" means "engineer submitted today" — once it's
    // filed, even if it transitions to CLOSED later, it counts here.
    prisma.inspectionRecord.count({
      where: { reportDate: { gte: startOfToday, lt: endOfToday } },
    }),
    // closedToday: rows that TRANSITIONED to CLOSED today. Inspection
    // records don't have a dedicated closedAt column; we use updatedAt as
    // the best proxy because the close transition sets status='CLOSED' +
    // updatedAt=now inside a $transaction. (A re-edit on a CLOSED row
    // would bump updatedAt again — acceptable; the label is "Closed Today"
    // not "Closed and not edited today".)
    prisma.inspectionRecord.count({
      where: {
        status: 'CLOSED',
        updatedAt: { gte: startOfToday, lt: endOfToday },
      },
    }),
    // acknowledged: org-wide count of records an admin has explicitly
    // ACK'd. Status 'ACKNOWLEDGED' is the entry-point state for review
    // (vs OPEN which is the engineer's submission state).
    prisma.inspectionRecord.count({ where: { status: 'ACKNOWLEDGED' } }),
    // pendingReview: rows an admin can still pick up. Inspection reviewable
    // states (matching B-06's REVIEWABLE_STATUSES) are
    // OPEN / IN_PROGRESS / PENDING_VERIFICATION. ACKNOWLEDGED is the
    // "I've seen it" state — it's no longer pending action from the admin
    // until it moves to IN_PROGRESS.
    prisma.inspectionRecord.count({
      where: { status: { in: ['OPEN', 'IN_PROGRESS', 'PENDING_VERIFICATION'] } },
    }),
    // totalActive: every non-terminal record. Terminal states are CLOSED
    // and REJECTED — same model as DPR's totalActive.
    prisma.inspectionRecord.count({
      where: { status: { in: ['OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS', 'PENDING_VERIFICATION'] } },
    }),
  ]);

  res.json({
    openNow,
    filedToday,
    closedToday,
    acknowledged,
    pendingReview,
    totalActive,
    window: {
      // Echo back the window so the client can render "as of <ts>" if it
      // wants to — useful for diagnosing clock-skew between server and DB.
      // LPR-013: timezone is now the IST business day (was 'UTC'). The
      // instant values are unchanged shape — UTC midnights of consecutive
      // IST calendar days — but the label tells the reader which day
      // boundary is in effect so a future debugger doesn't have to
      // re-derive it.
      start: startOfToday.toISOString(),
      end: endOfToday.toISOString(),
      timezone: 'Asia/Kolkata',
    },
  });
}));

// ─── GET /api/inspection/:id ────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  const prisma = getPrisma(req);
  const { id } = req.params;

  try {
    const record = await prisma.inspectionRecord.findUnique({
      where: { id },
      include: {
        // Same trick as dpr.js: include the parent record's submittedById on
        // each photo so read-SAS can rebuild the `${employeeId}/${ulid}.${ext}`
        // tenant prefix the upload wrote under.
        photos: {
          include: { inspection: { select: { submittedById: true } } },
        },
        submittedBy: { select: { id: true, name: true, email: true } },
        dpr: { select: { id: true, reportDate: true, projectName: true } },
        // N7 (round-28): BOQ summary on detail. Same select shape as
        // the list endpoint.
        boqItem: { select: { id: true, itemCode: true, description: true, unit: true } },
        // [N1] Project summary on detail. Same shape as the list endpoint.
        project: { select: { id: true, name: true, code: true } },
        // [N3] Drawing summary on detail. Same shape as the list endpoint.
        drawing: { select: { id: true, drawingNumber: true, revision: true, status: true } },
      },
    });

    if (!record) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Inspection record not found' });
    }

    // SOL DR-006: quarantine unattributed legacy inspection drafts (same
    // rationale as the equivalent guard in dpr.js:1206). A pre-FK row
    // with `submittedById == null` cannot be safely attributed to the
    // first reader, so we hide its existence from non-admins with a 404.
    if (record.submittedById == null) {
      const owner = await prisma.employee.findUnique({ where: { id: req.employeeId } });
      const isAdmin = owner && owner.isAdmin;
      if (!isAdmin) {
        return res.status(404).json({ error: 'NOT_FOUND', message: 'Inspection record not found' });
      }
    }

    const employee = await prisma.employee.findUnique({ where: { id: req.employeeId } });
    const isAdmin = employee && employee.isAdmin;
    if (record.submittedById !== req.employeeId && !isAdmin) {
      return res.status(403).json({ error: 'FORBIDDEN', message: 'Not authorized' });
    }

    // Generate read SAS URLs for photos — mirror dpr.js logic.
    const inspectionOwnerId = record.submittedById;
    const photosWithUrls = await Promise.all(record.photos.map(async p => {
      const ext = CONTENT_TYPE_EXT[p.contentType];
      const employeeId = (p.inspection && p.inspection.submittedById) || inspectionOwnerId;
      const blobName = ext
        ? `${employeeId}/${p.ulid}.${ext}`
        : `${employeeId}/${p.ulid}`;
      const { sasUrl } = await generateReadSASUrl(p.container, blobName);
      const { inspection: _join, ...photoForClient } = p;
      return { ...photoForClient, readUrl: sasUrl };
    }));

    // DR-022: surface the structured rejection decision in the GET DTO.
    // The InspectionRecord schema has no top-level rejection columns
    // (only `status`), so we read the latest REJECT entry from the
    // existing `_adminNotes` JSON history (populated by the transition
    // handler in this same file). The handler now stores `reason` on
    // the REJECT entry, so the GET DTO has a single source of truth
    // for `rejectionReason` / `rejectionNotes` / `rejectedBy` /
    // `rejectedAt` without re-parsing the unrelated notification
    // message. We resolve the reviewer `by` (cuid) into a minimal
    // Employee row so the UI can render a name without a second fetch.
    let rejectionReason = null;
    let rejectionNotes = null;
    let rejectedBy = null;
    let rejectedAt = null;
    if (record.status === 'REJECTED') {
      const notes = (((record.data || {})._adminNotes) || []);
      // Walk the history in reverse to find the most recent REJECT
      // entry. Bulk and single paths both write to this array, so
      // the latest REJECT always reflects the most recent decision.
      for (let i = notes.length - 1; i >= 0; i -= 1) {
        const entry = notes[i];
        if (entry && entry.action === 'REJECT') {
          rejectionReason = entry.reason || null;
          rejectionNotes = entry.notes || null;
          rejectedAt = entry.at || null;
          if (entry.by) {
            const reviewer = await prisma.employee.findUnique({
              where: { id: entry.by },
              select: { id: true, name: true, email: true },
            });
            rejectedBy = reviewer || { id: entry.by, name: null, email: null };
          }
          break;
        }
      }
    }

    res.json({
      ...record,
      photos: photosWithUrls,
      rejectionReason,
      rejectionNotes,
      rejectedBy,
      rejectedAt,
    });
  } catch (err) {
    console.error('Inspection get error', {
      employeeHash: hashIdentifier(req.employeeId),
      prismaCode: err.code,
      message: err.message?.split('\n')[0],
    });
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to fetch inspection record' });
  }
});

// ─── PUT /api/inspection/:id ────────────────────────────────────────────────
// Owner-only update; only allowed while status = OPEN (locked once
// acknowledged or progressed). Same mass-assignment allowlist pattern as
// dpr.js P0-1 — explicit allowlist prevents IDOR on submittedById etc.
//
// DR-004 (round-20): two bugs the audit caught:
//   1. The previous ALLOWED_UPDATE_FIELDS included `status`. The owner
//      could send `status: 'CLOSED'` via PUT and silently mark a
//      record as admin-decided without going through the admin queue.
//      `status` is removed from the owner allowlist — the dedicated
//      /acknowledge /close /reject endpoints (and bulk-review) are
//      the only legal way out of OPEN.
//   2. The handler required a `version` field in the body and used
//      `where: { id, version: existing.version }` on the conditional
//      update — but InspectionRecord has NO version column in the
//      schema (see prisma/schema.prisma: model InspectionRecord). The
//      WHERE clause never matched and every PUT 409'd with
//      VERSION_CONFLICT. We now accept a plain PUT body without a
//      version field and update by `id`.
//
// LPR-008: read-time status check (below) plus a `status: 'OPEN'` pin
// on the WHERE makes the owner PUT race-safe against a concurrent admin
// transition. Scenario: owner reads row at OPEN, admin /acknowledge
// moves it to ACKNOWLEDGED in between, owner PUT lands. Without the
// WHERE pin the update would silently overwrite the acknowledged row;
// now the conditional WHERE matches no row, Prisma throws P2025, and
// the catch translates that to a 409 INSPECTION_LOCKED — same wire
// shape the read-time check uses, so clients only see one error.
router.put('/:id', async (req, res) => {
  const prisma = getPrisma(req);
  const { id } = req.params;
  const fields = req.body || {};

  // `version` was a phantom — reject explicitly so any client still
  // sending it gets a clear 400 instead of silently working (or, as
  // before, silently 409'ing on the dead WHERE clause).
  if ('version' in fields) {
    return res.status(400).json({
      error: 'version is not a valid field on inspection records',
      code: 'VERSION_FIELD_INVALID',
    });
  }

  const ALLOWED_UPDATE_FIELDS = [
    // [N1] projectId + projectName are both on the allowlist. Same
    // resolution contract as the DPR PUT handler below — see dpr.js
    // for the full rationale and the resolveTargetProjectName helper.
    'projectName', 'projectId', 'location', 'reportDate', 'weather', 'contractor',
    'inspectionType', 'data', 'severity', 'dprId',
    // N7 (round-28): BOQ link — same allowlist extension as DPR PUT.
    'boqItemId',
    // [N3] Phase E: drawing link — same allowlist extension as DPR PUT.
    'drawingId', 'drawingRev',
    // SOL DR-004: typed additive photo additions. Mirrors the DPR PUT
    // pattern: `photos` is a control field (NOT a column on the row),
    // stripped before the data spread so Prisma doesn't try to set a
    // non-existent scalar. The validation block + dedupe + binding all
    // run below in the same transaction as the row update.
    'photos',
  ];
  const unknown = Object.keys(fields).filter(k => !ALLOWED_UPDATE_FIELDS.includes(k));
  if (unknown.length) {
    return res.status(400).json({
      error: 'UNKNOWN_FIELDS',
      message: `Fields not allowed: ${unknown.join(', ')}`,
      fields: unknown,
    });
  }

  // Read the existing row up front. The boqItemId validation below
  // (round-28) already falls back to `existing.projectName` when the
  // caller PUTs only a boqItemId without a fresh projectId/projectName;
  // DR-009's data-shape validation also needs `existing.inspectionType`
  // to know which required-array contract applies. Without the early
  // fetch both call sites would TDZ on the const.
  const existing = await prisma.inspectionRecord.findUnique({ where: { id } });
  if (!existing) {
    return res.status(404).json({ error: 'NOT_FOUND', message: 'Inspection record not found' });
  }
  if (existing.submittedById !== req.employeeId) {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Only owner can update' });
  }
  // SOL DR-005: DRAFT is also editable by the owner — that's the whole
  // point of "Save as Draft". Once the record transitions to OPEN (and
  // beyond) the state machine takes over and only the dedicated
  // /acknowledge, /close, /reject endpoints can move it forward.
  if (existing.status !== 'OPEN' && existing.status !== 'DRAFT') {
    return res.status(409).json({
      error: 'INSPECTION_LOCKED',
      code: 'INSPECTION_LOCKED',
      message: `Cannot edit a record in status ${existing.status}`,
    });
  }

  // Length caps on string fields
  const MAX = { projectName: 200, location: 200, weather: 80, contractor: 200 };
  for (const [k, cap] of Object.entries(MAX)) {
    if (fields[k] != null && typeof fields[k] === 'string' && fields[k].length > cap) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: `${k} exceeds ${cap} chars` });
    }
  }

  if (fields.reportDate !== undefined) {
    const dp = parseStrictISODate(fields.reportDate);
    if (!dp.ok) return res.status(400).json({ error: 'INVALID_REPORT_DATE', message: 'reportDate must be YYYY-MM-DD' });
    fields.reportDate = dp.date;
    // DR-027: without this, PUT is a trivial bypass of the create-time check.
    if (rejectIfFutureReportDate(req, res, fields.reportDate, 'inspection.update')) return;
  }

  // N7 (round-28): boqItemId PUT validation. Same contract as POST —
  // must exist + be active + match the (possibly-updated) projectName.
  if (fields.boqItemId !== undefined) {
    if (fields.boqItemId === null) {
      // Allowed — clears the link.
    } else if (typeof fields.boqItemId !== 'string' || !fields.boqItemId) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', code: 'VALIDATION_ERROR', message: 'boqItemId must be a string or null' });
    } else {
      const boq = await prisma.boqItem.findUnique({ where: { id: fields.boqItemId }, select: { id: true, projectName: true, isActive: true } });
      if (!boq) {
        return res.status(400).json({ error: 'BOQ_ITEM_NOT_FOUND', code: 'BOQ_ITEM_NOT_FOUND', message: 'Linked BOQ item does not exist' });
      }
      if (!boq.isActive) {
        return res.status(400).json({ error: 'BOQ_ITEM_INACTIVE', code: 'BOQ_ITEM_INACTIVE', message: 'Linked BOQ item is archived (isActive=false)' });
      }
      // [N1] Compare against the canonical target project name. If the
      // owner PUT set projectId, use the Project row's name; if they
      // set projectName, use that; otherwise fall back to the stored
      // row. Mirrors the dpr.js helper — see resolveTargetProjectName
      // there for the rationale.
      const targetProjectName = (typeof fields.projectId === 'string' && fields.projectId)
        ? ((await prisma.project.findUnique({ where: { id: fields.projectId }, select: { name: true } }))?.name || fields.projectId)
        : ((typeof fields.projectName === 'string' && fields.projectName.trim())
          ? fields.projectName.trim()
          : existing.projectName);
      if (boq.projectName.trim() !== targetProjectName) {
        return res.status(400).json({ error: 'BOQ_PROJECT_MISMATCH', code: 'BOQ_PROJECT_MISMATCH', message: 'Linked BOQ item belongs to a different projectName' });
      }
    }
  }

  // [N1] PUT projectId resolution. When the owner PUTs a projectId, we
  // validate it (must exist + be active) AND derive the canonical
  // projectName from the resolved Project row — so the denormalized
  // projectName column stays in sync with the FK. Symmetric with the
  // POST resolution block above.
  if (fields.projectId !== undefined && fields.projectId !== null) {
    if (typeof fields.projectId !== 'string' || !fields.projectId) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', code: 'VALIDATION_ERROR', message: 'projectId must be a string or null' });
    }
    const p = await prisma.project.findUnique({ where: { id: fields.projectId } });
    if (!p || !p.isActive) {
      return res.status(400).json({ error: 'PROJECT_NOT_FOUND', code: 'PROJECT_NOT_FOUND', message: 'Linked project does not exist or is inactive' });
    }
    fields.projectId = p.id;
    fields.projectName = p.name;
  } else if (fields.projectName !== undefined && typeof fields.projectName === 'string' && fields.projectName.trim()) {
    // Free-text projectName PUT with no projectId: try to resolve to a
    // curated Project row. If found, take its id + name (side-effect
    // promotion of the FK). If not found, leave the typed projectName
    // and projectId unset — the existing row keeps its FK state.
    const result = await resolveProject(prisma, fields.projectName.trim());
    if (result.kind === 'project') {
      if (!result.project.isActive) {
        return res.status(400).json({ error: 'PROJECT_INACTIVE', code: 'PROJECT_INACTIVE', message: 'Project is archived (isActive=false)' });
      }
      fields.projectId = result.project.id;
      fields.projectName = result.project.name;
    }
    // kind === 'discovered' / 'missing' → keep typed projectName; FK stays NULL.
  }

  if (fields.inspectionType !== undefined && !ALLOWED_INSPECTION_TYPES.has(fields.inspectionType)) {
    return res.status(422).json({ error: 'inspectionType not allowed', code: 'INSPECTION_TYPE_INVALID' });
  }
  if (fields.severity !== undefined && fields.severity !== null && !ALLOWED_SEVERITIES.has(fields.severity)) {
    return res.status(422).json({ error: 'severity not allowed', code: 'SEVERITY_INVALID' });
  }
  // Effective inspectionType for the data-shape checks below: a PUT
  // can change inspectionType in the same request, so use the new value
  // when present, otherwise the existing row's type.
  const effectiveInspectionType = fields.inspectionType || existing.inspectionType;
  // DR-008-F: effective data for the merged-pair validation. A type-only
  // PUT (no `data` in the body) must still satisfy the new type's required
  // arrays against the existing data — omitting `data` cannot be a trivial
  // bypass of the create-time check. When `data` is supplied, validate the
  // new value; otherwise validate `existing.data` against the effective
  // type.
  const effectiveData = fields.data !== undefined ? fields.data : existing.data;
  // DR-009: normalised severity used at write time (same rationale as
  // the POST handler — wire top-level wins, data.severity Title Case
  // promotes into the canonical column when wire is null).
  let normalisedSeverity = fields.severity;
  if (fields.data !== undefined) {
    if (fields.data == null || typeof fields.data !== 'object' || Array.isArray(fields.data)) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'data must be a JSON object' });
    }
    const oversized = findOversizedStrings(fields.data, 'data', 5000);
    if (oversized.length) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: `data has oversized string fields: ${oversized.slice(0, 3).join('; ')}`,
        field: 'data',
      });
    }
  }

  // DR-008-F + DR-009: required-array contract enforcement on PUT. Runs
  // whenever a non-DRAFT row's effective (type, data) pair is about to be
  // committed — including type-only PUTs that omit `data` (the merged pair
  // is `new type + existing data`). DRAFT rows are exempt — the barest
  // bones is the whole point of "Save as Draft".
  if (existing.status !== 'DRAFT') {
    const requiredArrays = REQUIRED_ARRAY_FIELDS_BY_TYPE[effectiveInspectionType] || [];
    for (const fieldName of requiredArrays) {
      const arr = effectiveData && effectiveData[fieldName];
      if (!Array.isArray(arr) || arr.length === 0) {
        return res.status(400).json({
          error: 'VALIDATION_ERROR',
          code: 'REQUIRED_FIELD_EMPTY',
          message: `${fieldName} must contain at least one entry`,
          field: `data.${fieldName}`,
        });
      }
    }
  }

  if (fields.data !== undefined) {
    // DR-009: severity normalization on PUT. Wire top-level `severity`
    // is already allowlist-validated above (line 1332); this block
    // promotes `data.severity` (Title Case from the form selector)
    // into the canonical column when wire top-level is null/undefined.
    if (
      SUBTYPES_WITH_STRUCTURED_SEVERITY.has(effectiveInspectionType)
      && typeof fields.data.severity === 'string'
      && fields.data.severity.length > 0
    ) {
      const mapped = SEVERITY_TITLE_TO_CANONICAL[fields.data.severity];
      if (mapped === undefined) {
        return res.status(422).json({
          error: `data.severity not recognized: ${fields.data.severity}`,
          code: 'SEVERITY_INVALID',
          allowed: Object.keys(SEVERITY_TITLE_TO_CANONICAL),
        });
      }
      if (normalisedSeverity === null || normalisedSeverity === undefined) {
        normalisedSeverity = mapped;
      }
    }
  }

  // [N3] Phase E: drawingId PUT validation. Same shape as POST —
  // drawing must exist, must belong to the target project (either
  // newly-set in this PUT, or the existing row's project if projectId
  // isn't being changed), and drawingRev is denormalized from the row
  // unless the client overrides.
  if (fields.drawingId !== undefined) {
    const targetProjectId = fields.projectId || existing.projectId;
    const drawingResolution = await resolveDrawingForReport({
      prisma,
      drawingId: fields.drawingId === '' ? null : fields.drawingId,
      drawingRev: fields.drawingRev,
      resolvedProjectId: targetProjectId,
    });
    if (drawingResolution.error) {
      if (typeof drawingResolution.error === 'string') {
        return res.status(400).json({ error: 'VALIDATION_ERROR', code: 'VALIDATION_ERROR', message: drawingResolution.error });
      }
      return res.status(drawingResolution.error.status).json(drawingResolution.error.body);
    }
    fields.drawingId = drawingResolution.drawingId ?? null;
    fields.drawingRev = drawingResolution.drawingRev ?? null;
  }

  // SOL DR-004: typed additive photos on inspection PUT. Mirrors the
  // POST validation block — same shape checks (ulid regex, container,
  // content-type, size, filename, takenAt). Empty `photos: []` is the
  // additive no-op signal; `photos` undefined means "no change" and
  // skips the block entirely (the previous owner-edit path silently
  // dropped newly-added photos because the editPayload never carried
  // them through).
  let incomingInspectionPhotos = [];
  if (fields.photos !== undefined) {
    const photos = fields.photos;
    if (!Array.isArray(photos) || photos.length > 50) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'photos must be an array (max 50)' });
    }
    for (let i = 0; i < photos.length; i += 1) {
      const p = photos[i];
      if (!p || typeof p !== 'object') {
        return res.status(400).json({ error: 'VALIDATION_ERROR', message: `photos[${i}] must be an object` });
      }
      if (typeof p.ulid !== 'string' || !/^[0-9A-HJKMNP-TV-Z]{26}$/i.test(p.ulid)) {
        return res.status(400).json({ error: 'VALIDATION_ERROR', message: `photos[${i}].ulid invalid` });
      }
      if (p.container !== 'inspection-photos') {
        return res.status(400).json({ error: 'VALIDATION_ERROR', message: `photos[${i}].container must be inspection-photos` });
      }
      if (!CONTENT_TYPE_EXT[p.contentType]) {
        return res.status(400).json({ error: 'INVALID_CONTENT_TYPE', message: `photos[${i}].contentType invalid` });
      }
      const sb = Number(p.sizeBytes);
      if (!Number.isFinite(sb) || sb <= 0 || sb > 10 * 1024 * 1024) {
        return res.status(413).json({ error: 'PHOTO_TOO_LARGE', message: `photos[${i}].sizeBytes must be 1..${10 * 1024 * 1024}` });
      }
      if (typeof p.filename !== 'string' || p.filename.length > 255 || p.filename.includes('\0') || p.filename.includes('..')) {
        return res.status(400).json({ error: 'VALIDATION_ERROR', message: `photos[${i}].filename invalid` });
      }
      if (p.takenAt !== undefined && p.takenAt !== null) {
        const td = parseISODateTime(p.takenAt);
        if (td === null) return res.status(400).json({ error: 'VALIDATION_ERROR', message: `photos[${i}].takenAt invalid` });
      }
    }
    incomingInspectionPhotos = photos;
  }

  // SOL DR-004: every photo must map to a CONFIRMED upload intent owned
  // by THIS employee. Same pre-flight as POST — the loop above only
  // checks the ulid's 26-char Crockford shape, which a client can
  // trivially fabricate. Without this gate, a forged ulid could attach
  // to an inspection PUT.
  if (incomingInspectionPhotos.length > 0) {
    const intentErr = await validatePhotoIntents({
      prisma,
      employeeId: req.employeeId,
      photos: incomingInspectionPhotos,
      context: 'inspection.update',
    });
    if (intentErr) return res.status(intentErr.status).json(intentErr.body);
  }

  // SOL DR-004: server-side dedupe by `(inspectionId, container, ulid)`.
  // The audit's exact symptom: a one-photo inspection became two rows
  // with the same ULID after a notes-only edit. Frontend re-sent
  // previously-persisted photos in every Save; the schema has no
  // unique constraint so the nested `create` happily duplicated them.
  // Server filters here so a stale page that rehydrates server-side
  // photos as plain ulids (without the persisted marker the client
  // also uses) cannot leak duplicates through.
  let dedupedInspectionPhotos = incomingInspectionPhotos;
  if (incomingInspectionPhotos.length > 0) {
    const existingPhotos = await prisma.inspectionPhoto.findMany({
      where: { inspectionId: id },
      select: { ulid: true, container: true },
    });
    const existingKeys = new Set(
      existingPhotos.map((p) => `${p.container}::${p.ulid}`),
    );
    dedupedInspectionPhotos = incomingInspectionPhotos.filter(
      (p) => p && !existingKeys.has(`${p.container}::${p.ulid}`),
    );
  }

  try {
    // LPR-008: pin `status` on the WHERE so a concurrent admin
    // ack/close/reject (or owner /submit promotion) between our read and
    // our update cannot be silently overwritten. We accept both OPEN
    // (the published-state edit) and DRAFT (the SOL DR-005 owner-edit
    // path) — same conditional shape, broader input. If Prisma rejects
    // with P2025, the catch below maps it to 409 INSPECTION_LOCKED
    // (same wire shape as the read-time check) so clients only see one
    // error code.
    //
    // SOL DR-004: the update + photo nested create + intent binding
    // runs inside ONE transaction. A short binding count throws
    // PhotoBindingLostError and the entire tx rolls back — the row
    // stays at its pre-edit content/status and the just-created photo
    // rows are removed. `photos` is a control field (NOT a column on
    // the row), so it MUST be stripped before the data spread;
    // otherwise Prisma would try to set a non-existent `photos`
    // scalar. The conditional WHERE keeps the LPR-008 race-safety
    // (concurrent admin transitions still P2025 to INSPECTION_LOCKED).
    const { photos: _photoControlField, ...fieldsForUpdate } = fields;
    const inspectionPhotoWrites = dedupedInspectionPhotos.length > 0
      ? {
          create: dedupedInspectionPhotos.map((p) => ({
            ulid: p.ulid,
            container: p.container,
            filename: p.filename,
            contentType: p.contentType,
            sizeBytes: p.sizeBytes,
            caption: p.caption || null,
            location: p.location || null,
            takenAt: p.takenAt ? new Date(p.takenAt) : null,
          })),
        }
      : undefined;
    const updated = await withRecordTransaction(prisma, 'inspectionRecord', async (db) => {
      const u = await db.inspectionRecord.update({
        where: { id, status: existing.status },
        data: {
          ...fieldsForUpdate,
          // DR-009: write the normalised severity rather than the raw wire
          // value so a PUT that arrived with `severity: null` + a clean
          // `data.severity` still promotes to the canonical column.
          severity: normalisedSeverity === undefined ? fields.severity : normalisedSeverity || null,
          updatedAt: new Date(),
          ...(inspectionPhotoWrites ? { photos: inspectionPhotoWrites } : {}),
        },
        include: {
          photos: true,
          submittedBy: { select: { id: true, name: true, email: true } },
          dpr: { select: { id: true, reportDate: true, projectName: true } },
          // N7 (round-28): BOQ summary on PUT response, mirror of POST.
          boqItem: { select: { id: true, itemCode: true, description: true, unit: true } },
          // [N1] Project summary on PUT response, mirror of POST.
          project: { select: { id: true, name: true, code: true } },
          // [N3] Drawing summary on PUT response, mirror of POST.
          drawing: { select: { id: true, drawingNumber: true, revision: true, status: true } },
        },
      });

      // SOL DR-004: bind the intents for the deduped-new photo rows in
      // the SAME transaction as the row update. A short count throws
      // and the entire transaction rolls back — row stays at its
      // pre-edit content/status, no orphan photo rows are created.
      // Empty dedupedInspectionPhotos (e.g. the client sent only
      // already-persisted ulids) short-circuits — no intent check, no
      // write — so an unchanged Save keeps the existing photo count.
      if (dedupedInspectionPhotos.length > 0) {
        await assertPhotoIntentsBindable({
          tx: db,
          employeeId: req.employeeId,
          photos: dedupedInspectionPhotos,
        });
        await bindPhotoIntentsTx({
          tx: db,
          employeeId: req.employeeId,
          photos: dedupedInspectionPhotos,
          boundType: 'inspection',
          recordId: id,
        });
      }

      return u;
    });

    res.json(updated);
  } catch (err) {
    // SOL DR-004: a lost photo claim is not a server fault — the tx
    // rolled back, the row is unchanged, and the client can recover
    // by re-uploading. 409, never 500, and never the generic prisma
    // mapping. The INSPECTION_LOCKED P2025 branch below stays
    // untouched so a concurrent admin transition still surfaces the
    // same wire code as the read-time check.
    const bindingLost = photoBindingLostResponse(err);
    if (bindingLost) {
      console.warn('Inspection update rolled back — photo binding lost', {
        employeeHash: hashIdentifier(req.employeeId),
        expected: err.expected,
        bound: err.bound,
      });
      return res.status(bindingLost.status).json(bindingLost.body);
    }
    console.error('Inspection update error', {
      employeeHash: hashIdentifier(req.employeeId),
      prismaCode: err.code,
      message: err.message?.split('\n')[0],
    });
    // LPR-008: a P2025 from the conditional WHERE means the row's
    // status drifted off OPEN between our read and our write (an admin
    // ack/close/reject landed in between). Translate to the same
    // 409 INSPECTION_LOCKED the read-time check uses, so the client
    // only sees one error code for the same condition. mapPrismaError
    // would otherwise surface this as a generic 404 NOT_FOUND, which
    // is the wrong wire shape.
    if (err.code === 'P2025') {
      return res.status(409).json({
        error: 'INSPECTION_LOCKED',
        code: 'INSPECTION_LOCKED',
        message: 'Inspection moved out of OPEN during edit; refetch and retry',
      });
    }
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to update inspection record' });
  }
});

// ─── Admin state-machine helpers (Round-17 B-06) ────────────────────────────
//
// Inspection & Compliance Records use a String `status` column (no version
// column). The DPR bulk-review's `status + version` conditional update can't
// be applied verbatim — we fall back to a `status`-only conditional update,
// which still gives race-safe behavior for the admin operation window
// (two concurrent admins clicking on the same row: one wins, the other gets
// P2025 → we translate to VERSION_CONFLICT).
//
// Mirrors the round-17 DPR bulk-review pattern:
//   - Per-ID prisma.$transaction (one failure doesn't roll back the rest)
//   - Tagged error throws ({ _code, _status }) so the per-row bucket is precise
//   - DB notification row written in-txn; no SSE emit here because
//     inspection.js doesn't own the SSE plumbing — bell refresh picks up new
//     rows on the next /api/dpr/notifications/list call. Message includes
//     the inspection id so the owner has context (the Notification table has
//     no inspectionId FK — schema is frozen by the B-06 constraint).
//   - adminNotes persisted on the inspection row so admins can leave an
//     audit-visible note alongside each ack/close/reject.

const ACK_FROM = new Set(['OPEN']);
const CLOSE_FROM = new Set(['ACKNOWLEDGED', 'IN_PROGRESS', 'PENDING_VERIFICATION']);
const REJECT_FROM = new Set(['OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS', 'PENDING_VERIFICATION']);
// SOL DR-005: SUBMIT promotes DRAFT → OPEN. Only the OWNER can submit —
// an admin promoting someone else's draft would (a) bypass the owner's
// review of their own work and (b) trigger admin fan-out to themselves.
// The route guards owner-check below.
const SUBMIT_FROM = new Set(['DRAFT']);

const INSPECTION_INCLUDE = {
  photos: true,
  submittedBy: { select: { id: true, name: true, email: true } },
  dpr: { select: { id: true, reportDate: true, projectName: true } },
};

// Shared per-record transition helper used by both the single-record endpoints
// and the bulk-review loop. Throws tagged errors on failure so callers can
// branch on _code / _status without re-implementing the state-machine logic.
async function transitionInspectionRecord(prisma, id, action, payload, actorEmployeeId, options = {}) {
  const { allowAdminOverride = false } = options;

  // DR-027: none of the three transition endpoints accepts a reportDate today
  // — they only move `status` and append `_adminNotes`. This guard exists so
  // that if a future transition ever carries a date correction through
  // `payload`, it cannot slip past the no-future rule the way create/update
  // did. All callers here are `req.isAdmin`-gated, so they pass
  // allowAdminOverride:true and a deliberate future date is audit-logged
  // rather than rejected.
  if (payload && payload.reportDate !== undefined) {
    assertNotFutureReportDate(payload.reportDate, {
      allowAdminOverride,
      actor: actorEmployeeId,
      resource: `inspection.${String(action).toLowerCase()}`,
    });
  }

  const allowedFrom =
    action === 'ACKNOWLEDGE' ? ACK_FROM
    : action === 'CLOSE' ? CLOSE_FROM
    : action === 'REJECT' ? REJECT_FROM
    : action === 'SUBMIT' ? SUBMIT_FROM
    : null;
  if (!allowedFrom) {
    throw Object.assign(new Error(`Unknown action ${action}`), { _code: 'UNKNOWN_ACTION', _status: 400 });
  }

  let nextStatus;
  let notifType;
  // SOL DR-021: explicit action labels so the persisted type literal
  // (and the SSE wire `type`) reads as the human action, not a slug.
  // The audit's `submitd` was a misspelling of SUBMIT / SUBMITTED in a
  // downstream surface; the source fix is to keep `notifType` and the
  // SSE payload `type` identical by reusing the same constant here.
  if (action === 'ACKNOWLEDGE') { nextStatus = 'ACKNOWLEDGED'; notifType = 'INSPECTION_ACKNOWLEDGED'; }
  else if (action === 'CLOSE') { nextStatus = 'CLOSED'; notifType = 'INSPECTION_CLOSED'; }
  else if (action === 'SUBMIT') { nextStatus = 'OPEN'; notifType = 'INSPECTION_SUBMITTED'; } // SOL DR-007: write a per-record notif to the owner with a non-null type literal (Notification.type is required). Admin fan-out still fires post-tx.
  else { nextStatus = 'REJECTED'; notifType = 'INSPECTION_REJECTED'; }

  // SOL DR-021: track whether the transition actually committed. SUBMIT
  // returns early on the OPEN replay branch (see below) — that replay
  // must NOT emit a second SSE event nor a second email fan-out. The
  // helper now returns `{ record, transitioned, notification }` so the
  // caller can branch on whether to emit provider-side work.
  const result = { record: null, transitioned: false, notification: null };
  const txOutcome = await prisma.$transaction(async (tx) => {
    const record = await tx.inspectionRecord.findUnique({
      where: { id },
      include: INSPECTION_INCLUDE,
    });
    if (!record) {
      throw Object.assign(new Error('Inspection record not found'), { _code: 'NOT_FOUND', _status: 404 });
    }

    // SOL DR-002: SUBMIT is owner-only — check BEFORE the idempotent
    // OPEN replay return so a foreign user with the UUID cannot read
    // the OPEN record back through this endpoint. Normal GET denies
    // non-owners at inspection.js:1145; this keeps the SUBMIT command
    // consistent. SOL DR-005: even an admin token cannot promote
    // someone else's draft — that would (a) silently bypass the owner's
    // review of their own work and (b) trigger admin fan-out to the
    // admin themselves, which is the queue-bypass vector the original
    // audit flagged. We let the admin transition helpers (CLOSE/REJECT)
    // take over from the resulting OPEN state through their own
    // admin-gated routes.
    if (action === 'SUBMIT' && record.submittedById !== actorEmployeeId) {
      throw Object.assign(
        new Error('Only the owner can submit a draft'),
        { _code: 'NOT_OWNER', _status: 403 }
      );
    }

    // SOL DR-007: idempotent re-submit. If the row is already OPEN
    // (i.e. the owner submitted once and the request was retried after
    // the original committed), return the row as-is without writing a
    // second notification row or firing a second admin fan-out. Without
    // this, the API.js NETWORK_ERROR retry (api.js:168-178) would 409
    // the user with INVALID_TRANSITION even though the row is in the
    // correct terminal state — reading as "the system rejected my
    // submit" instead of "you're already done". Only OPEN gets the
    // idempotent path; ACKNOWLEDGED/CLOSED/REJECTED still 409 because
    // they were moved by an admin and the owner has no business
    // re-submitting. Owner-only is enforced above so this replay
    // returns the row to its rightful owner, never to a foreign caller.
    //
    // DR-021: return a sentinel `{ replayed: true, record }` so the
    // outer helper knows not to fire fan-out / SSE for the replay.
    if (action === 'SUBMIT' && record.status === 'OPEN') {
      return { replayed: true, record };
    }

    if (!allowedFrom.has(record.status)) {
      throw Object.assign(
        new Error(`Cannot move inspection from ${record.status} to ${nextStatus}`),
        { _code: 'INVALID_TRANSITION', _status: 409 }
      );
    }

    // DR-008-A/B: SUBMIT promotes DRAFT → OPEN, which has the same
    // required-array contract as create. A draft can be cleared of its
    // required arrays by a separate PUT between save and publish — the
    // SUBMIT must validate the row's CURRENT data, not assume the
    // create-time payload is still valid. Mirrors the POST handler's
    // required-array check (inspection.js:455) so direct create, edit
    // and publish enforce the same contract. DRAFT rows in the audit
    // scenario never reach this branch (they would have been blocked by
    // the create-time gate), but a row that landed here via a PUT that
    // emptied the checklist must still be rejected.
    if (action === 'SUBMIT') {
      const requiredArrays = REQUIRED_ARRAY_FIELDS_BY_TYPE[record.inspectionType] || [];
      const recordData = record.data || {};
      for (const fieldName of requiredArrays) {
        const arr = recordData[fieldName];
        if (!Array.isArray(arr) || arr.length === 0) {
          throw Object.assign(
            new Error(`${fieldName} must contain at least one entry`),
            {
              _code: 'REQUIRED_FIELD_EMPTY',
              _status: 400,
              field: `data.${fieldName}`,
            }
          );
        }
      }
    }

    // Schema-driven update — no `data` allowlist (no submittedById /
    // submittedAt / etc. on InspectionRecord to mass-assign). We only set
    // columns we control here, and adminNotes lives on a JSON-ish payload
    // merged into the inspection record's `data` JSON.
    //
    // DR-022: always record a REJECT decision in `_adminNotes` even when
    // the admin didn't supply an `adminNotes` blob, so the rejection
    // reason + reviewer + timestamp survive in the structured note
    // history. Without this, a reject that only carries a `reason`
    // (the common case) writes nothing to `_adminNotes` and the GET
    // DTO has no source for `rejectionReason` / `rejectedBy` /
    // `rejectedAt`. Reusing the existing _adminNotes structure (rather
    // than adding a new top-level column) keeps the audit trail
    // co-located and forward-compatible with the existing
    // reviewer-facing display.
    const dataPatch = {
      status: nextStatus,
    };
    const shouldAppendAudit =
      action === 'REJECT' ||
      (payload.adminNotes && typeof payload.adminNotes === 'string');
    if (shouldAppendAudit) {
      const auditEntry = {
        by: actorEmployeeId,
        action,
        notes: payload.adminNotes || null,
        at: new Date().toISOString(),
      };
      // DR-022: surface the rejection reason on the same audit entry so
      // the GET DTO can hydrate `rejectionReason` without re-parsing
      // the unrelated notification row.
      if (action === 'REJECT' && payload.reason) {
        auditEntry.reason = payload.reason.trim();
      }
      dataPatch.data = {
        ...(record.data || {}),
        _adminNotes: [...(((record.data || {})._adminNotes) || []), auditEntry],
      };
    }

    // Race-safe conditional update on `status` + `updatedAt` (no version
    // column on this model). A concurrent admin action that already
    // flipped status, or a concurrent owner PUT that bumped updatedAt,
    // will throw P2025 from Prisma; we translate that to a tagged
    // VERSION_CONFLICT. DR-008-C: pinning `updatedAt` on SUBMIT closes
    // the "concurrent invalidating edit" race the audit flagged — a
    // draft PUT that clears the required array between our read and
    // our update now trips the CAS instead of slipping past validation
    // on stale content.
    const conditionalUpdate = await tx.inspectionRecord.update({
      where: { id, status: record.status, updatedAt: record.updatedAt },
      data: dataPatch,
    }).catch((err) => {
      if (err.code === 'P2025') {
        throw Object.assign(new Error('version conflict'), { _code: 'VERSION_CONFLICT', _status: 409 });
      }
      throw err;
    });
    if (!conditionalUpdate) {
      throw Object.assign(new Error('version conflict'), { _code: 'VERSION_CONFLICT', _status: 409 });
    }

    // SOL-P2#13: human-readable label for the inspection type so the
    // bell/toast reads "Cube Testing" instead of "cube_testing", and the
    // raw cuid is no longer dumped into the message body (employees were
    // seeing a 24-char id appended to every notification).
    const messageParts = [
      `Your ${labelizeInspectionType(record.inspectionType)} for ${record.projectName} on ${formatInspectionReportDate(record.reportDate)} was ${action.toLowerCase()}d.`,
    ];
    if (action === 'REJECT' && payload.reason) messageParts.push(`Reason: ${payload.reason.trim()}`);
    if (payload.adminNotes) messageParts.push(`Notes: ${payload.adminNotes}`);
    // SOL DR-021: persist the actual notification row (with the inspection
    // id) so the SSE wire shape can carry the SAME UUID the /list endpoint
    // returns. The previous flow created the row, returned it as `void`,
    // and re-derived a numeric id for the SSE payload — which broke
    // `markNotificationRead` (404 on numeric id) AND broke the bell's
    // stream/list dedupe (numeric vs uuid).
    const notification = await tx.notification.create({
      data: {
        employeeId: record.submittedById,
        type: notifType,
        inspectionId: id,
        message: messageParts.join('\n'),
      },
      select: {
        id: true,
        type: true,
        inspectionId: true,
        message: true,
        createdAt: true,
        isRead: true,
      },
    });

    const freshRecord = await tx.inspectionRecord.findUnique({
      where: { id },
      include: INSPECTION_INCLUDE,
    });

    // DR-021: tx-callback returns the fresh record + the persisted
    // notification row. Fan-out / SSE work runs OUTSIDE the transaction
    // (after commit) so a slow SMTP send doesn't hold the row lock, and
    // a rollback discards the notification rather than emitting a
    // phantom event. fanOutEmail now receives the actual persisted id
    // so EmailLog.notificationId is real, not the old `null`.
    return { replayed: false, record: freshRecord, notification };
  });

  // DR-021: replay short-circuit. The SUBMIT-from-OPEN replay returns
  // the record without writing anything new — caller must not emit
  // SSE / fan-out for a replay.
  if (txOutcome && txOutcome.replayed) {
    result.record = txOutcome.record;
    result.transitioned = false;
    return result;
  }

  const { record: freshRecord, notification } = txOutcome;
  result.record = freshRecord;
  result.transitioned = true;
  result.notification = notification;

  // Round-25: schedule email fan-out AFTER the transaction commits.
  // The helper is fire-and-forget so the route handler returns
  // immediately; the send runs in the next tick of the event loop with
  // the actual persisted notification row id, so EmailLog.notificationId
  // is real (not the legacy `null` placeholder). For REJECT, pass the
  // reason so the email can surface it in the body.
  if (notification) {
    fanOutEmail(notification, prisma, {
      reason: action === 'REJECT' ? payload.reason?.trim() : null,
    });
  }

  return result;
}

// Defensive: reportDate may deserialize as Date or "YYYY-MM-DD" string.
function formatInspectionReportDate(d) {
  if (d instanceof Date) return d.toISOString().split('T')[0];
  return String(d);
}

// ─── POST /api/inspection/:id/acknowledge ───────────────────────────────────
// OPEN → ACKNOWLEDGED. Admin only.
//
// LPR-007: ack is a mutation; requireFreshAdmin re-reads isAdmin
// from the DB instead of trusting the up-to-15-minute-old JWT claim.
router.post('/:id/acknowledge', requireFreshAdmin, async (req, res) => {
  const prisma = getPrisma(req);
  const { id } = req.params;
  const { adminNotes } = req.body || {};

  if (adminNotes !== undefined && (typeof adminNotes !== 'string' || adminNotes.length > 2000)) {
    return res.status(400).json({ error: 'NOTES_TOO_LONG', message: 'adminNotes must be <= 2000 chars' });
  }

  try {
    const result = await transitionInspectionRecord(
      prisma,
      id,
      'ACKNOWLEDGE',
      { adminNotes },
      req.employeeId,
      { allowAdminOverride: true } // DR-027: route is req.isAdmin-gated above
    );
    // SOL DR-021: `result` is now `{ record, transitioned, notification }`.
    // Caller returns the record (wire contract unchanged) — provider work
    // (fanOutEmail, SSE) already ran inside the helper.
    res.json(result.record);
  } catch (err) {
    return inspectionHandleTransitionError(req, res, err, 'acknowledge');
  }
});

// ─── POST /api/inspection/:id/close ─────────────────────────────────────────
// ACKNOWLEDGED|IN_PROGRESS|PENDING_VERIFICATION → CLOSED. Admin only.
//
// LPR-007: close is a mutation; requireFreshAdmin re-reads isAdmin
// from the DB instead of trusting the up-to-15-minute-old JWT claim.
router.post('/:id/close', requireFreshAdmin, async (req, res) => {
  const prisma = getPrisma(req);
  const { id } = req.params;
  const { adminNotes } = req.body || {};

  if (adminNotes !== undefined && (typeof adminNotes !== 'string' || adminNotes.length > 2000)) {
    return res.status(400).json({ error: 'NOTES_TOO_LONG', message: 'adminNotes must be <= 2000 chars' });
  }

  try {
    const result = await transitionInspectionRecord(
      prisma,
      id,
      'CLOSE',
      { adminNotes },
      req.employeeId,
      { allowAdminOverride: true } // DR-027: route is req.isAdmin-gated above
    );
    // SOL DR-021: see ACKNOWLEDGE above.
    res.json(result.record);
  } catch (err) {
    return inspectionHandleTransitionError(req, res, err, 'close');
  }
});

// ─── POST /api/inspection/:id/reject ─────────────────────────────────────────
// OPEN|ACKNOWLEDGED|IN_PROGRESS|PENDING_VERIFICATION → REJECTED. Admin only.
// Reason is required so the owner knows what to fix.
//
// LPR-007: reject is a mutation; requireFreshAdmin re-reads isAdmin
// from the DB instead of trusting the up-to-15-minute-old JWT claim.
router.post('/:id/reject', requireFreshAdmin, async (req, res) => {
  const prisma = getPrisma(req);
  const { id } = req.params;
  const { reason, adminNotes } = req.body || {};

  if (!reason || typeof reason !== 'string' || !reason.trim()) {
    return res.status(400).json({ error: 'REASON_REQUIRED', message: 'A reason is required to reject an inspection' });
  }
  if (reason.length > 1000) {
    return res.status(400).json({ error: 'REASON_TOO_LONG', message: 'Reason must be <= 1000 chars' });
  }
  if (adminNotes !== undefined && (typeof adminNotes !== 'string' || adminNotes.length > 2000)) {
    return res.status(400).json({ error: 'NOTES_TOO_LONG', message: 'adminNotes must be <= 2000 chars' });
  }

  try {
    const result = await transitionInspectionRecord(
      prisma,
      id,
      'REJECT',
      { reason, adminNotes },
      req.employeeId,
      { allowAdminOverride: true } // DR-027: route is req.isAdmin-gated above
    );
    // SOL DR-021: see ACKNOWLEDGE above.
    res.json(result.record);
  } catch (err) {
    return inspectionHandleTransitionError(req, res, err, 'reject');
  }
});

// ─── POST /api/inspection/:id/submit ─────────────────────────────────────────
// SOL DR-005: DRAFT → OPEN transition owned by the OWNER. This is the
// single intentional path a draft takes into the admin review queue.
// Any other way of getting a draft onto the queue would have to come
// from an admin mutation on an already-OPEN record (CLOSE / REJECT
// chains), so the fan-out fires exactly once per draft submission.
//
// We do NOT require requireFreshAdmin here — submission is an owner
// action, and the admin-claim check is for admin-only endpoints.
router.post('/:id/submit', async (req, res) => {
  const prisma = getPrisma(req);
  const { id } = req.params;

  try {
    // SOL DR-007/DR-021: snapshot the row's status BEFORE the tx so the
    // idempotent OPEN re-submit path can skip the admin fan-out. The
    // helper now returns `{ record, transitioned, notification }` — the
    // `transitioned` flag carries the same skip-fan-out signal as the
    // old `isIdempotentReplay`, so we no longer need a separate read.
    const updated = await transitionInspectionRecord(
      prisma,
      id,
      'SUBMIT',
      {},
      req.employeeId,
      { allowAdminOverride: false } // owner-only; no future-date override path
    );

    // Fan-out fires AFTER the tx commits — but only when the tx
    // actually transitioned the row. The idempotent OPEN replay path
    // sets `transitioned: false` so admins don't get a duplicate
    // "New inspection opened by …" message from a NETWORK_ERROR replay.
    if (updated.transitioned) {
      try {
        await fanOutToAdmins(
          {
            type: 'ADMIN_INSPECTION_OPENED',
            message: `New inspection opened by ${updated.record.submittedBy?.name || 'an employee'}: ${updated.record.inspectionType || 'inspection'}`,
            meta: {
              employeeName: updated.record.submittedBy?.name || 'an employee',
              recordTitle: updated.record.projectName || updated.record.inspectionType || 'an inspection',
              inspectionType: updated.record.inspectionType || '',
              inspectionId: updated.record.id,
            },
          },
          prisma,
        );
      } catch (adminErr) {
        console.error('Inspection submit fan-out error', {
          inspectionId: updated.record.id,
          message: adminErr?.message?.split('\n')[0],
        });
      }
    }

    res.json(updated.record);
  } catch (err) {
    return inspectionHandleTransitionError(req, res, err, 'submit');
  }
});

// Single-error handler for the three single-record transition endpoints.
function inspectionHandleTransitionError(req, res, err, action) {
  console.error(`Inspection ${action} error`, {
    employeeHash: hashIdentifier(req.employeeId),
    prismaCode: err.code,
    message: err.message?.split('\n')[0],
  });
  if (err._status) {
    // DR-008: surface the offending field path on the response body so the
    // client can highlight the empty required input. Mirrors the shape the
    // POST / PUT handlers already emit (REQUIRED_FIELD_EMPTY + `field`).
    const body = {
      error: err.message?.split('\n')[0] || 'Transition failed',
      code: err._code,
    };
    if (err.field) body.field = err.field;
    return res.status(err._status).json(body);
  }
  if (err.code === 'P2025') {
    return res.status(409).json({
      error: 'Inspection was modified by another action. Please refresh and try again.',
      code: 'VERSION_CONFLICT',
    });
  }
  const mapped = mapPrismaError(err);
  if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
  res.status(500).json({ error: `Failed to ${action} inspection` });
}

// ─── POST /api/inspection/bulk-review (Round-17 B-06) ───────────────────────
//
// Fan out an admin action (ACKNOWLEDGE | CLOSE | REJECT) over a list of
// inspection IDs. Per-ID transaction so one failure doesn't roll back the
// rest — admin UI shows per-row success/failure.
//
// Each ID goes through the SAME state-machine + per-ID tx as the single
// endpoint above, so the audit trail (adminNotes + Notification row) is
// identical whether the action came from the per-row menu or this batch.
//
// Cap: 100 IDs per call. Larger batches tie up the request for too long and
// aren't a realistic UI selection.

const INSPECTION_BULK_ACTIONS = new Set(['ACKNOWLEDGE', 'CLOSE', 'REJECT']);
const INSPECTION_BULK_MAX_IDS = 100;

// LPR-007: bulk-review is a mutation; requireFreshAdmin re-reads
// Employee.isAdmin from the DB once per request so a freshly demoted
// admin cannot flood in stale-JWT decisions across a batch.
router.post('/bulk-review', requireFreshAdmin, async (req, res) => {
  const prisma = getPrisma(req);
  const { ids, action, reason, adminNotes } = req.body || {};

  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'ids must be a non-empty array' });
  }
  if (ids.length > INSPECTION_BULK_MAX_IDS) {
    return res.status(400).json({
      error: 'BATCH_TOO_LARGE',
      message: `Cannot process more than ${INSPECTION_BULK_MAX_IDS} IDs in a single batch`,
    });
  }
  if (ids.some((id) => typeof id !== 'string' || !id.trim())) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'All ids must be non-empty strings' });
  }
  if (!INSPECTION_BULK_ACTIONS.has(action)) {
    return res.status(400).json({
      error: 'VALIDATION_ERROR',
      message: `action must be one of: ${[...INSPECTION_BULK_ACTIONS].join(', ')}`,
    });
  }
  if (action === 'REJECT') {
    if (!reason || typeof reason !== 'string' || !reason.trim()) {
      return res.status(400).json({ error: 'REASON_REQUIRED', message: 'A reason is required to reject inspections' });
    }
    if (reason.length > 1000) {
      return res.status(400).json({ error: 'REASON_TOO_LONG', message: 'Reason must be <= 1000 chars' });
    }
  }
  if (adminNotes && (typeof adminNotes !== 'string' || adminNotes.length > 2000)) {
    return res.status(400).json({ error: 'NOTES_TOO_LONG', message: 'adminNotes must be <= 2000 chars' });
  }

  // De-duplicate input — same ID twice would double-fire notifications.
  const uniqueIds = [...new Set(ids)];
  const succeeded = [];
  const failed = [];

  for (const id of uniqueIds) {
    try {
      const result = await transitionInspectionRecord(
        prisma,
        id,
        action,
        { reason, adminNotes },
        req.employeeId,
        { allowAdminOverride: true } // DR-027: route is req.isAdmin-gated above
      );
      // SOL DR-021: `result.record` is the post-commit record. We only
      // report this id as a success if the transition actually committed;
      // a SUBMIT replay (transitioned=false) is a silent no-op so it goes
      // to neither bucket — same effect as the old code, which would have
      // surfaced the OPEN replay as a successful row update with the
      // same status.
      if (result.transitioned) {
        succeeded.push({ id: result.record.id, newStatus: result.record.status });
      }
    } catch (err) {
      const code = err._code || (err.code === 'P2025' ? 'VERSION_CONFLICT' : 'INTERNAL');
      const status = err._status || (err.code === 'P2025' ? 409 : 500);
      failed.push({
        id,
        error: err.message?.split('\n')[0] || 'Unknown error',
        code,
        status,
      });
    }
  }

  res.json({
    total: uniqueIds.length,
    succeededCount: succeeded.length,
    failedCount: failed.length,
    succeeded,
    failed,
  });
});


module.exports = router;
