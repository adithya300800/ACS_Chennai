// Shared client-side constants. Keep in sync with backend validation rules.

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
