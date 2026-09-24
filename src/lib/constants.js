// Shared client-side constants. Keep in sync with backend validation rules.

import { isOverdue as isDueDateOverdue, getBusinessToday } from './businessDate.js';

export const MAX_PHOTO_BYTES = 10 * 1024 * 1024; // 10MB — matches backend photos[] sizeBytes cap
export const MAX_PHOTOS_PER_DPR = 10;
export const ACCEPTED_PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

// R35: Project Reports — file attachments per project (weekly / monthly /
// due-diligence / quality / other documents). Mirrors the widened
// backend allowlist on the dpr-documents R2 bucket (see
// backend/src/routes/dpr.js maxSizeBytesPerContainer) and the SAS-layer
// extension in backend/src/lib/blobStorage.js#CONTENT_TYPE_EXT. Both
// halves must accept the same MIME types or the upload pipeline 400s on
// INVALID_CONTENT_TYPE before the bytes ever leave the browser.
//
// 25 MB cap matches the per-container byte ceiling; high-res HEIC site
// photos + Office docs with embedded media routinely exceed 10 MB. Kept
// here so the upload form's inline validation and the file-picker
// `accept` attribute can pull from the same source.
export const MAX_REPORT_BYTES = 25 * 1024 * 1024; // 25 MB
export const ACCEPTED_REPORT_TYPES = [
  // Photos (incl. HEIC from iOS site cameras — see round-29).
  'image/jpeg', 'image/png', 'image/webp', 'image/heic',
  // PDFs (already accepted on dpr-documents for Drawing PDFs).
  'application/pdf',
  // Office — both legacy (.doc/.xls/.ppt) and OOXML (.docx/.xlsx/.pptx).
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  // Plain text + CSV (for ad-hoc reports exported from spreadsheets).
  'text/plain', 'text/csv',
];

// Map MIME → human label + short label for the type-filter chips + badges.
// Order matters — it defines the canonical chip order in the UI.
export const PROJECT_REPORT_TYPE_LABELS = {
  WEEKLY_REPORT:        { label: 'Weekly',         short: 'Weekly' },
  MONTHLY_REPORT:       { label: 'Monthly',        short: 'Monthly' },
  DUE_DILIGENCE_REPORT: { label: 'Due diligence',  short: 'Due Dil.' },
  QUALITY_REPORT:       { label: 'Quality',        short: 'Quality' },
  OTHER:                { label: 'Other',          short: 'Other' },
};
export const PROJECT_REPORT_TYPES = Object.keys(PROJECT_REPORT_TYPE_LABELS);

// [DocumentCategory] Subject-matter classifier for ProjectAttachment
// uploads. Mirrors the Prisma `DocumentCategory` enum in
// backend/prisma/schema.prisma — keep the value strings exactly in
// sync (the backend validates against this set on POST + on the GET
// ?category= filter). Independent of PROJECT_REPORT_TYPES (which
// describes report cadence, not subject matter).
//
// Order matters — it defines the canonical chip-row order on the
// employee form + admin filter row. 8 values keeps a single chip row
// wrapping cleanly on the 9.5" tablet breakpoint.
export const DOCUMENT_CATEGORY_LABELS = {
  CLIENT_APPROVALS_DELIVERABLES: {
    label: 'Client approvals / deliverables',
    short: 'Approvals',
  },
  DESIGN_DRAWINGS: {
    label: 'Design drawings',
    short: 'Drawings',
  },
  COST_BOQ: {
    label: 'Cost / BOQ',
    short: 'Cost / BOQ',
  },
  PROCUREMENT_VENDOR: {
    label: 'Procurement / vendor',
    short: 'Procurement',
  },
  SITE_PROGRESS_INSPECTIONS: {
    label: 'Site progress / inspections',
    short: 'Site progress',
  },
  QUALITY_SAFETY: {
    label: 'Quality / safety',
    short: 'Quality / safety',
  },
  CONTRACTS_CHANGE_ORDERS: {
    label: 'Contracts / change orders',
    short: 'Contracts',
  },
  HANDOVER_CLOSEOUT: {
    label: 'Handover / closeout',
    short: 'Handover',
  },
};
export const DOCUMENT_CATEGORIES = Object.keys(DOCUMENT_CATEGORY_LABELS);

// R44 — Flat taxonomy. The Project Reports upload form + filter row used
// to expose TWO chip rows: the 5 cadence values (PROJECT_REPORT_TYPES)
// and the 8 subject-matter values (DOCUMENT_CATEGORIES). The split
// surfaced the implementation choice (category is an additive column,
// not a replacement for `type`) to the user, where the underlying
// mental model is "one flat picker." This list merges both axes into a
// single ordered, single-select taxonomy of 13 values + an "All" sentry.
//
// Wire contract:
//   - `kind: 'type'`     → match `ProjectAttachment.type` (cadence).
//                          Choosing one of these on upload means a legacy
//                          review-flow row (type=that-value, category=null).
//                          `OTHER` is special — when it shows up in the
//                          filter alongside no category, the backend
//                          narrows to category IS NULL (true legacy Other).
//   - `kind: 'category'` → match `ProjectAttachment.category`. Choosing
//                          one of these on upload silently coerces type to
//                          'OTHER' (the route's R43 override) and tags the
//                          row for skipping the admin review queue.
//
// Order matters — it defines the canonical chip-row order in the UI.
// The 5 cadence values stay first so the existing cadence mental model
// (Weekly / Monthly / …) reads left-to-right, then the 8 categories
// follow as a second contiguous block. A single-chip-select picker on
// three surfaces — employee ReportSection, employee MyProjectReports,
// admin ReportsAdmin — all consume this array verbatim.
export const UNIFIED_TAXONOMY = [
  { value: 'WEEKLY_REPORT',                 kind: 'type',     label: 'Weekly',                short: 'Weekly' },
  { value: 'MONTHLY_REPORT',                kind: 'type',     label: 'Monthly',               short: 'Monthly' },
  { value: 'DUE_DILIGENCE_REPORT',          kind: 'type',     label: 'Due diligence',         short: 'Due Dil.' },
  { value: 'QUALITY_REPORT',                kind: 'type',     label: 'Quality',               short: 'Quality' },
  { value: 'OTHER',                         kind: 'type',     label: 'Other',                 short: 'Other' },
  { value: 'CLIENT_APPROVALS_DELIVERABLES', kind: 'category', label: 'Client approvals / deliverables', short: 'Approvals' },
  { value: 'DESIGN_DRAWINGS',               kind: 'category', label: 'Design drawings',       short: 'Drawings' },
  { value: 'COST_BOQ',                      kind: 'category', label: 'Cost / BOQ',            short: 'Cost / BOQ' },
  { value: 'PROCUREMENT_VENDOR',            kind: 'category', label: 'Procurement / vendor',  short: 'Procurement' },
  { value: 'SITE_PROGRESS_INSPECTIONS',     kind: 'category', label: 'Site progress / inspections', short: 'Site progress' },
  { value: 'QUALITY_SAFETY',                kind: 'category', label: 'Quality / safety',      short: 'Quality / safety' },
  { value: 'CONTRACTS_CHANGE_ORDERS',       kind: 'category', label: 'Contracts / change orders', short: 'Contracts' },
  { value: 'HANDOVER_CLOSEOUT',             kind: 'category', label: 'Handover / closeout',   short: 'Handover' },
];

// Look up a chip's { kind, label, short } by its enum value, or null
// for an unknown / unset selection. Used by every R44 surface to
// translate a chip click into the right upload (type vs category) or
// filter (which query param + value to forward) decision.
export function getTaxonomyChip(value) {
  if (!value) return null;
  return UNIFIED_TAXONOMY.find((c) => c.value === value) || null;
}

// Translate a chip selection into the upload form's state pair:
//   - When `value === null` (no chip / "All"), the user is on the
//     legacy cadence path — pick the default first type and clear the
//     category so the POST sends a null category.
//   - When the chip's `kind === 'type'`, the user picked a legacy
//     cadence — keep the category null and use the picked type.
//   - When the chip's `kind === 'category'`, the user picked a
//     subject-matter bucket — silently coerce type to 'OTHER' (the
//     route's R43 override) and stamp the category. Category-tagged
//     rows skip the admin review queue by design.
//
// The mapped pair is then passed directly to the file picker's
// 4-step upload pipeline + the existing coerce-effect useEffect
// (which still flips uploadType on uploadCategory change as a
// defensive backstop).
export function taxonomyToUploadState(value, defaultType = PROJECT_REPORT_TYPES[0]) {
  const chip = getTaxonomyChip(value);
  if (!chip) return { type: defaultType, category: null };
  if (chip.kind === 'type') return { type: chip.value, category: null };
  // kind === 'category' — silently coerce.
  return { type: 'OTHER', category: chip.value };
}

// Translate a chip selection into the API query-param pair the GET
// handlers expect:
//   - null         → no filter sent (the "All" sentinel clears both
//                    type and category on every surface).
//   - type, not OTHER       → { type: 'X' }            (legacy cadence)
//   - type, OTHER           → { type: 'OTHER' }        (the R44 narrowing
//                                                  kicks in server-side
//                                                  — type=OTHER alone now
//                                                  means category IS NULL)
//   - category              → { category: 'X' }        (since every
//                                                  category-tagged row is
//                                                  already type=OTHER, the
//                                                  category alone matches
//                                                  the right rows).
//
// Returns a plain object suitable for Object.assign / spread into the
// existing params dict. Empty objects are emitted for "no filter".
export function taxonomyToFilterParams(value) {
  const chip = getTaxonomyChip(value);
  if (!chip) return {};
  if (chip.kind === 'type') return { type: chip.value };
  // kind === 'category'
  return { category: chip.value };
}

// Round-14: Employee Training. Mirrors backend/src/lib/trainingRules.js
// values — keep in sync if the backend caps change.
//
// TRAINING_PROGRESS_PING_MS — how often the in-platform player POSTs
// progress to /api/training/enrollments/:id/progress. 10s is a good
// balance: fine-grained enough for a smooth progress bar, coarse
// enough to stay well under the 120/h trainingWriteLimiter budget
// (one ping per 10s = 360/h, so a single user with the player open
// all day would hit the limiter — the player should back off if 429).
export const TRAINING_PROGRESS_PING_MS = 10_000;
export const TRAINING_COMPLETION_THRESHOLD = 100; // pct at which to flip status -> COMPLETED

// Provider enum — same strings as the Prisma TrainingProvider enum
// and the backend ALLOWED_PROVIDERS set. UI uses these for badges,
// player routing, and conditional "open external" buttons.
export const TRAINING_PROVIDERS = {
  YOUTUBE: 'YOUTUBE',
  VIMEO: 'VIMEO',
  LINKEDIN_LEARNING: 'LINKEDIN_LEARNING',
  COURSERA: 'COURSERA',
  UDEMY: 'UDEMY',
  OTHER: 'OTHER',
};

// Human-readable labels for the provider badges.
export const TRAINING_PROVIDER_LABELS = {
  YOUTUBE: 'YouTube',
  VIMEO: 'Vimeo',
  LINKEDIN_LEARNING: 'LinkedIn Learning',
  COURSERA: 'Coursera',
  UDEMY: 'Udemy',
  OTHER: 'External',
};

// Status enum — mirrors Prisma TrainingStatus. Pill class names in
// CSS are derived from these (`training-pill-${status.toLowerCase()}`).
export const TRAINING_STATUSES = {
  ASSIGNED: 'ASSIGNED',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
};

// LPR-009: canonical terminal-status list shared between the backend
// (`backend/src/lib/trainingRules.js` isCompleted()) and every frontend
// filter, label, action guard, and progress loop. Mirrors the four
// evidence-class terminal states on the server.
//
// A row is "terminal" if it represents a finished enrollment — the union
// of the legacy `COMPLETED` value and the four evidence-class completions
// introduced in round-20. Both lists must stay in sync; the test suite in
// backend/__tests__/trainingRules.test.js pins the membership.
export const TRAINING_TERMINAL_STATUSES = [
  'COMPLETED',
  'SELF_ATTESTED_COMPLETED',
  'PLAYER_OBSERVED_COMPLETED',
  'PROVIDER_VERIFIED_COMPLETED',
  'ADMIN_OVERRIDE_COMPLETED',
];

export const TRAINING_TERMINAL_STATUS_SET = new Set(TRAINING_TERMINAL_STATUSES);

export const isTrainingTerminal = (status) => TRAINING_TERMINAL_STATUS_SET.has(status);

// DR-024: broader "no further action" predicate — the union of completion
// states AND the bookkeeping terminal states (CANCELLED, OVERDUE). Used at
// every boundary where progress writes, the embedded-player's onEnded
// handler, and the manual-complete button should stop. Kept separate from
// `isTrainingTerminal` so the "Completed" counters and filters in
// Training.jsx / TrainingDashboard.jsx still count exactly the 5
// *_COMPLETED states — we don't want CANCELLED rows silently bucketing
// into "Completed". Mirrors `isInactive()` in backend/src/lib/trainingRules.js.
export const TRAINING_INACTIVE_STATUSES = Object.freeze([
  ...TRAINING_TERMINAL_STATUSES,
  'CANCELLED',
  'OVERDUE',
]);

export const TRAINING_INACTIVE_STATUS_SET = new Set(TRAINING_INACTIVE_STATUSES);

export const isTrainingInactive = (status) => TRAINING_INACTIVE_STATUS_SET.has(status);

// DR-005: "attention-list" exclusion predicate. The union of every
// completion-state and CANCELLED — rows in any of these statuses are no
// longer actionable for the employee and must not surface in the
// overdue / due-soon attention lists on the dashboard, training hub, or
// admin queue. Importantly this set does NOT include OVERDUE: a row the
// backend has already persisted as OVERDUE is exactly what the
// attention list is meant to surface, so its badge still has to light
// up. (See the audit doc for the rationale.)
export const TRAINING_ATTENTION_EXCLUDED_STATUSES = Object.freeze([
  ...TRAINING_TERMINAL_STATUSES,
  'CANCELLED',
]);

export const TRAINING_ATTENTION_EXCLUDED_STATUS_SET = new Set(TRAINING_ATTENTION_EXCLUDED_STATUSES);

export const isTrainingAttentionExcluded = (status) => TRAINING_ATTENTION_EXCLUDED_STATUS_SET.has(status);

// DR-005: shared overdue predicate for every employee/admin training
// surface. Centralised so the three pages (Training.jsx,
// TrainingDashboard.jsx, EmployeeDashboard.jsx) can't drift — pre-fix
// each file had its own local `isOverdue` that only excluded terminal
// completion states, so CANCELLED rows with a past dueDate kept showing
// up as "overdue" on the dashboard. The shared helper excludes the
// attention-excluded set (completion states + CANCELLED) and reuses the
// businessDate isOverdue for the date comparison so the predicate stays
// in lockstep with the displayed business-day clock.
export function isOverdueEnrollment(enrollment, optsOrNow) {
  if (!enrollment?.dueDate) return false;
  if (isTrainingAttentionExcluded(enrollment.status)) return false;
  return isDueDateOverdue(enrollment.dueDate, optsOrNow);
}

// DR-005: shared "due in the next N days" predicate for the dashboard's
// due-soon list. Mirrors the overdue helper — same exclusion set, same
// clock. `windowDays` defaults to 7 so the employee dashboard's "Nothing
// due in the next week." copy stays accurate.
export function isDueSoonEnrollment(enrollment, optsOrNow, windowDays = 7) {
  if (!enrollment?.dueDate) return false;
  if (isTrainingAttentionExcluded(enrollment.status)) return false;
  // Already overdue is handled by the overdue list — don't double-count.
  if (isDueDateOverdue(enrollment.dueDate, optsOrNow)) return false;
  const due = String(enrollment.dueDate).split('T')[0];
  const today = getBusinessToday(
    (optsOrNow && optsOrNow.now) || undefined,
    (optsOrNow && optsOrNow.timezone) || undefined
  );
  const diff = (new Date(`${due}T00:00:00Z`).getTime() - new Date(`${today}T00:00:00Z`).getTime())
    / (1000 * 60 * 60 * 24);
  return diff >= 0 && diff <= windowDays;
}

// Priority — used to sort + colour the pill on admin rows.
export const TRAINING_PRIORITIES = {
  LOW: 'LOW',
  NORMAL: 'NORMAL',
  HIGH: 'HIGH',
};

// Providers where we can embed a real player + auto-capture progress.
// LinkedIn Learning / Coursera / Udemy / generic URLs block embedding
// via X-Frame-Options, so the UI shows an "Open course" button instead
// and the employee must click Mark Complete manually.
export const TRACKABLE_PROVIDERS = new Set(['YOUTUBE', 'VIMEO']);

// R37: COP / Billing Certification Register — status enum mirrors
// backend BillingCertificationStatus. The minimal 3-state machine
// (DRAFT → CERTIFIED → DISPUTED → CERTIFIED) was chosen to match the
// email-evidenced workflow: a COP is drafted offline in Excel, an admin
// signs it (CERTIFIED), and a client/contractor may later raise a
// dispute (DISPUTED). The "create + immediately certify" path keeps
// both DRAFT and CERTIFIED valid initial states so the wire contract
// doesn't force two round-trips for the common case.
export const BILLING_CERTIFICATION_STATUSES = {
  DRAFT: 'DRAFT',
  CERTIFIED: 'CERTIFIED',
  DISPUTED: 'DISPUTED',
};
export const BILLING_CERTIFICATION_STATUS_LABELS = {
  DRAFT: { label: 'Draft', tone: 'muted' },
  CERTIFIED: { label: 'Certified', tone: 'success' },
  DISPUTED: { label: 'Disputed', tone: 'danger' },
};
