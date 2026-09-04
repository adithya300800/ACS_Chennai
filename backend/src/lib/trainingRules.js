// Pure training validators. No I/O, fully unit-testable.
//
// Mirrors `lib/leaveRules.js` shape: allowlists for provider/status/priority,
// URL parsing with provider auto-detection, payload validators, status
// transition table, code → HTTP status mapper.
//
// Allowed training providers. Strings match the Prisma enum values
// (TrainingProvider.YOUTUBE etc.) so the server can write them directly
// without an additional mapping.
'use strict';

const ALLOWED_PROVIDERS = new Set([
  'YOUTUBE',
  'VIMEO',
  'LINKEDIN_LEARNING',
  'COURSERA',
  'UDEMY',
  'OTHER',
]);

const ALLOWED_STATUSES = new Set([
  'ASSIGNED',
  'IN_PROGRESS',
  // Four completed-states — distinguished by evidenceClass, but listed here
  // so legacy `?status=COMPLETED` filters and the canTransition() allowlist
  // keep working for callers that don't yet know about evidence classes.
  'SELF_ATTESTED_COMPLETED',
  'PLAYER_OBSERVED_COMPLETED',
  'PROVIDER_VERIFIED_COMPLETED',
  'ADMIN_OVERRIDE_COMPLETED',
  // Bookkeeping states driven by the admin / a future cron, not the
  // employee. The progress route never writes either of these directly.
  'OVERDUE',
  'CANCELLED',
]);

// Round-20 (DR-010): the four "how did this enrollment end up completed?"
// evidence classes. The COMPLETED-status column holds the union of all four;
// `evidenceClass` records which one fired for a given row.
const EVIDENCE_CLASSES = new Set([
  'SELF_ATTESTED',
  'PLAYER_OBSERVED',
  'PROVIDER_VERIFIED',
  'ADMIN_OVERRIDE',
]);

// Map evidence class → the canonical completed-status enum value.
const EVIDENCE_TO_STATUS = {
  SELF_ATTESTED: 'SELF_ATTESTED_COMPLETED',
  PLAYER_OBSERVED: 'PLAYER_OBSERVED_COMPLETED',
  PROVIDER_VERIFIED: 'PROVIDER_VERIFIED_COMPLETED',
  ADMIN_OVERRIDE: 'ADMIN_OVERRIDE_COMPLETED',
};

// Reverse lookup — for the badge / reports to show "PLAYER_OBSERVED" given a
// stored status like "PLAYER_OBSERVED_COMPLETED".
const STATUS_TO_EVIDENCE = Object.fromEntries(
  Object.entries(EVIDENCE_TO_STATUS).map(([k, v]) => [v, k])
);

// Returns true for any of the four completed-states. (Overdue + Cancelled
// are NOT completed — they're terminal-but-not-done states.)
//
// LPR-009: export `TERMINAL_STATUSES` as the single source of truth so the
// routes and the frontend share the same list. Frontend mirrors this in
// src/lib/constants.js (TRAINING_TERMINAL_STATUSES) — both sides must
// stay in sync.
const TERMINAL_STATUSES = Object.freeze([
  'SELF_ATTESTED_COMPLETED',
  'PLAYER_OBSERVED_COMPLETED',
  'PROVIDER_VERIFIED_COMPLETED',
  'ADMIN_OVERRIDE_COMPLETED',
]);
const TERMINAL_STATUS_SET = new Set(TERMINAL_STATUSES);

function isCompleted(status) {
  return TERMINAL_STATUS_SET.has(status);
}

const ALLOWED_PRIORITIES = new Set([
  'LOW',
  'NORMAL',
  'HIGH',
]);

const MAX_TITLE_LEN = 160;
const MAX_DESCRIPTION_LEN = 4000;
const MAX_CATEGORY_LEN = 60;
const MAX_EMPLOYEE_NOTE_LEN = 500;
const MAX_URL_LEN = 2048;
const MAX_EMPLOYEE_IDS_PER_BULK = 500;

// Host → provider mapping. Lowercased hostname → provider. Anything not
// matching falls through to null (the route then defaults to 'OTHER' for
// storage). Kept conservative — only the hosts where we actually have a
// working embed strategy.
const HOST_PROVIDER_MAP = {
  'youtube.com': 'YOUTUBE',
  'www.youtube.com': 'YOUTUBE',
  'youtu.be': 'YOUTUBE',
  'm.youtube.com': 'YOUTUBE',
  'youtube-nocookie.com': 'YOUTUBE',
  'www.youtube-nocookie.com': 'YOUTUBE',
  'vimeo.com': 'VIMEO',
  'www.vimeo.com': 'VIMEO',
  'player.vimeo.com': 'VIMEO',
  'linkedin.com': 'LINKEDIN_LEARNING',
  'www.linkedin.com': 'LINKEDIN_LEARNING',
  'coursera.org': 'COURSERA',
  'www.coursera.org': 'COURSERA',
  'udemy.com': 'UDEMY',
  'www.udemy.com': 'UDEMY',
};

// Detect provider from a URL's hostname. Returns the enum string or null.
function detectProviderFromUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol)) return null;
  const host = url.hostname.toLowerCase();
  if (HOST_PROVIDER_MAP[host]) return HOST_PROVIDER_MAP[host];
  return null;
}

// Pull a YouTube video ID out of any of the common URL shapes:
//   https://www.youtube.com/watch?v=ID
//   https://youtu.be/ID
//   https://www.youtube.com/embed/ID
//   https://www.youtube.com/shorts/ID
// Returns the 11-char ID string or null.
function extractYouTubeId(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  let url;
  try { url = new URL(rawUrl); } catch { return null; }
  if (!/^https?:$/.test(url.protocol)) return null;
  const host = url.hostname.toLowerCase();
  if (host === 'youtu.be') {
    const id = url.pathname.replace(/^\/+/, '').split('/')[0];
    return /^[A-Za-z0-9_-]{6,15}$/.test(id) ? id : null;
  }
  if (host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com')) {
    const v = url.searchParams.get('v');
    if (v && /^[A-Za-z0-9_-]{6,15}$/.test(v)) return v;
    const parts = url.pathname.split('/').filter(Boolean);
    const idx = parts.findIndex((p) => p === 'embed' || p === 'shorts' || p === 'v');
    if (idx >= 0 && parts[idx + 1] && /^[A-Za-z0-9_-]{6,15}$/.test(parts[idx + 1])) {
      return parts[idx + 1];
    }
  }
  return null;
}

// Pull a Vimeo video ID (numeric) from common URL shapes:
//   https://vimeo.com/123456789
//   https://player.vimeo.com/video/123456789
// Returns the numeric string or null.
function extractVimeoId(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  let url;
  try { url = new URL(rawUrl); } catch { return null; }
  if (!/^https?:$/.test(url.protocol)) return null;
  const host = url.hostname.toLowerCase();
  if (host !== 'vimeo.com' && host !== 'player.vimeo.com') return null;
  const parts = url.pathname.split('/').filter(Boolean);
  // Find the first all-numeric segment.
  for (const p of parts) {
    if (/^\d{6,12}$/.test(p)) return p;
  }
  return null;
}

// Validate + normalize an external URL. Rejects javascript:/data:/file: schemes
// and anything over MAX_URL_LEN. Returns { ok, value, provider } where provider
// is the auto-detected provider, or null if the URL is unrecognized.
function parseExternalUrl(rawUrl) {
  if (rawUrl == null) {
    return { ok: false, code: 'INVALID_URL', message: 'externalUrl is required' };
  }
  if (typeof rawUrl !== 'string') {
    return { ok: false, code: 'INVALID_URL', message: 'externalUrl must be a string' };
  }
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) {
    return { ok: false, code: 'INVALID_URL', message: 'externalUrl is required' };
  }
  if (trimmed.length > MAX_URL_LEN) {
    return { ok: false, code: 'URL_TOO_LONG', message: `externalUrl must be at most ${MAX_URL_LEN} characters` };
  }
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, code: 'INVALID_URL', message: 'externalUrl must be a valid http(s) URL' };
  }
  if (!/^https?:$/.test(url.protocol)) {
    return { ok: false, code: 'INVALID_URL_SCHEME', message: 'externalUrl must use http or https' };
  }
  return { ok: true, value: trimmed, provider: detectProviderFromUrl(trimmed) };
}

// Validate the body for POST /api/training/courses (admin create).
function validateCreateCourse(body) {
  if (!body || typeof body !== 'object') {
    return { ok: false, code: 'INVALID_BODY', message: 'Body required' };
  }
  const urlResult = parseExternalUrl(body.externalUrl);
  if (!urlResult.ok) return urlResult;

  if (typeof body.title !== 'string' || body.title.trim().length === 0) {
    return { ok: false, code: 'INVALID_TITLE', message: 'title is required' };
  }
  const title = body.title.trim();
  if (title.length > MAX_TITLE_LEN) {
    return { ok: false, code: 'TITLE_TOO_LONG', message: `title must be at most ${MAX_TITLE_LEN} characters` };
  }

  let description = null;
  if (body.description != null) {
    if (typeof body.description !== 'string') {
      return { ok: false, code: 'INVALID_DESCRIPTION', message: 'description must be a string' };
    }
    description = body.description.trim() || null;
    if (description && description.length > MAX_DESCRIPTION_LEN) {
      return { ok: false, code: 'DESCRIPTION_TOO_LONG', message: `description must be at most ${MAX_DESCRIPTION_LEN} characters` };
    }
  }

  let category = null;
  if (body.category != null) {
    if (typeof body.category !== 'string') {
      return { ok: false, code: 'INVALID_CATEGORY', message: 'category must be a string' };
    }
    category = body.category.trim() || null;
    if (category && category.length > MAX_CATEGORY_LEN) {
      return { ok: false, code: 'CATEGORY_TOO_LONG', message: `category must be at most ${MAX_CATEGORY_LEN} characters` };
    }
  }

  let provider = body.provider;
  if (provider != null) {
    if (typeof provider !== 'string' || !ALLOWED_PROVIDERS.has(provider)) {
      return {
        ok: false,
        code: 'INVALID_PROVIDER',
        message: `provider must be one of: ${[...ALLOWED_PROVIDERS].join(', ')}`,
      };
    }
  } else {
    provider = urlResult.provider || 'OTHER';
  }

  let durationHint = null;
  if (body.durationHint != null) {
    const n = Number(body.durationHint);
    if (!Number.isFinite(n) || n < 0 || n > 24 * 60 * 60) {
      return { ok: false, code: 'INVALID_DURATION', message: 'durationHint must be a non-negative number of seconds (max 86400)' };
    }
    durationHint = Math.floor(n);
  }

  return {
    ok: true,
    value: {
      title,
      description,
      externalUrl: urlResult.value,
      provider,
      category,
      durationHint,
    },
  };
}

// Allowed keys on PUT /api/training/courses/:id (strict-field rejection).
const ALLOWED_COURSE_UPDATE_FIELDS = ['title', 'description', 'externalUrl', 'provider', 'category', 'durationHint', 'isArchived'];

// Validate the body for PUT /api/training/courses/:id. Unknown fields → 400.
function validateUpdateCourse(body) {
  if (!body || typeof body !== 'object') {
    return { ok: false, code: 'INVALID_BODY', message: 'Body required' };
  }
  const unknown = Object.keys(body).filter((k) => !ALLOWED_COURSE_UPDATE_FIELDS.includes(k));
  if (unknown.length > 0) {
    return { ok: false, code: 'UNKNOWN_FIELDS', message: `Unknown fields: ${unknown.join(', ')}` };
  }

  const patch = {};

  if (body.title !== undefined) {
    if (typeof body.title !== 'string' || body.title.trim().length === 0) {
      return { ok: false, code: 'INVALID_TITLE', message: 'title must be a non-empty string' };
    }
    const title = body.title.trim();
    if (title.length > MAX_TITLE_LEN) {
      return { ok: false, code: 'TITLE_TOO_LONG', message: `title must be at most ${MAX_TITLE_LEN} characters` };
    }
    patch.title = title;
  }

  if (body.description !== undefined) {
    if (body.description != null && typeof body.description !== 'string') {
      return { ok: false, code: 'INVALID_DESCRIPTION', message: 'description must be a string or null' };
    }
    patch.description = body.description == null ? null : (body.description.trim() || null);
  }

  if (body.category !== undefined) {
    if (body.category != null && typeof body.category !== 'string') {
      return { ok: false, code: 'INVALID_CATEGORY', message: 'category must be a string or null' };
    }
    patch.category = body.category == null ? null : (body.category.trim() || null);
    if (patch.category && patch.category.length > MAX_CATEGORY_LEN) {
      return { ok: false, code: 'CATEGORY_TOO_LONG', message: `category must be at most ${MAX_CATEGORY_LEN} characters` };
    }
  }

  if (body.externalUrl !== undefined) {
    const urlResult = parseExternalUrl(body.externalUrl);
    if (!urlResult.ok) return urlResult;
    patch.externalUrl = urlResult.value;
  }

  if (body.provider !== undefined) {
    if (typeof body.provider !== 'string' || !ALLOWED_PROVIDERS.has(body.provider)) {
      return {
        ok: false,
        code: 'INVALID_PROVIDER',
        message: `provider must be one of: ${[...ALLOWED_PROVIDERS].join(', ')}`,
      };
    }
    patch.provider = body.provider;
  }

  if (body.durationHint !== undefined) {
    if (body.durationHint === null) {
      patch.durationHint = null;
    } else {
      const n = Number(body.durationHint);
      if (!Number.isFinite(n) || n < 0 || n > 24 * 60 * 60) {
        return { ok: false, code: 'INVALID_DURATION', message: 'durationHint must be a non-negative number of seconds (max 86400)' };
      }
      patch.durationHint = Math.floor(n);
    }
  }

  if (body.isArchived !== undefined) {
    patch.isArchived = !!body.isArchived;
  }

  if (Object.keys(patch).length === 0) {
    return { ok: false, code: 'NO_CHANGES', message: 'At least one field must be provided' };
  }

  return { ok: true, value: patch };
}

// Validate the body for POST /api/training/enrollments (admin bulk-assign).
// Accepts EITHER `employeeIds[]` (cuids) OR `employeeEmails[]` — the route
// handler resolves emails → ids server-side. This matches the v1 UI flow
// where admins paste emails in a textarea instead of selecting from a list.
function validateAssignEnrollments(body) {
  if (!body || typeof body !== 'object') {
    return { ok: false, code: 'INVALID_BODY', message: 'Body required' };
  }

  if (typeof body.courseId !== 'string' || body.courseId.trim().length === 0) {
    return { ok: false, code: 'INVALID_COURSE_ID', message: 'courseId is required' };
  }

  // Must have one of employeeIds / employeeEmails
  const hasIds = Array.isArray(body.employeeIds);
  const hasEmails = Array.isArray(body.employeeEmails);
  if (!hasIds && !hasEmails) {
    return { ok: false, code: 'INVALID_EMPLOYEE_IDS', message: 'employeeIds or employeeEmails must be an array' };
  }
  const rawList = hasIds ? body.employeeIds : body.employeeEmails;
  if (rawList.length === 0) {
    return { ok: false, code: 'NO_EMPLOYEES', message: 'employee list must contain at least one entry' };
  }
  if (rawList.length > MAX_EMPLOYEE_IDS_PER_BULK) {
    return {
      ok: false,
      code: 'TOO_MANY_EMPLOYEES',
      message: `Cannot assign to more than ${MAX_EMPLOYEE_IDS_PER_BULK} employees in one request`,
    };
  }
  const seen = new Set();
  const cleaned = [];
  for (const entry of rawList) {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      return { ok: false, code: 'INVALID_EMPLOYEE_ID', message: 'employee entries must be non-empty strings' };
    }
    const v = entry.trim();
    if (!seen.has(v.toLowerCase())) {
      seen.add(v.toLowerCase());
      cleaned.push(v);
    }
  }

  let dueDate = null;
  if (body.dueDate != null) {
    if (typeof body.dueDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body.dueDate)) {
      return { ok: false, code: 'INVALID_DUE_DATE', message: 'dueDate must be a YYYY-MM-DD string or null' };
    }
    const [y, m, d] = body.dueDate.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (
      dt.getUTCFullYear() !== y ||
      dt.getUTCMonth() !== m - 1 ||
      dt.getUTCDate() !== d
    ) {
      return { ok: false, code: 'INVALID_DUE_DATE', message: 'dueDate is not a valid calendar date' };
    }
    dueDate = dt;
  }

  let priority = 'NORMAL';
  if (body.priority != null) {
    if (typeof body.priority !== 'string' || !ALLOWED_PRIORITIES.has(body.priority)) {
      return {
        ok: false,
        code: 'INVALID_PRIORITY',
        message: `priority must be one of: ${[...ALLOWED_PRIORITIES].join(', ')}`,
      };
    }
    priority = body.priority;
  }

  return {
    ok: true,
    value: {
      courseId: body.courseId,
      employeeIds: cleaned,
      employeeEmails: hasEmails ? cleaned : null,
      dueDate,
      priority,
    },
  };
}

// Validate the body for PUT /api/training/enrollments/:id/progress.
// progressPct must be 0..100; lastWatchedSec must be >= 0 and >= previous -5
// (the -5 tolerance allows resume after a refresh; anything beyond that is
// treated as a malicious skip).
//
// `provider` and `evidenceMetadata` are optional but, when present, let the
// route handler decide whether `progressPct >= 100` is allowed to auto-flip
// the row to PLAYER_OBSERVED_COMPLETED. For YOUTUBE / VIMEO providers the
// client MUST send a non-empty `metadata.sessionId` (the IFrame API
// session token) before 100% will be accepted — this is the DR-010
// defense against a tampered client claiming "I watched to the end".
function validateProgressPayload(body, previousPct = 0) {
  if (!body || typeof body !== 'object') {
    return { ok: false, code: 'INVALID_BODY', message: 'Body required' };
  }
  const pctRaw = body.progressPct;
  const secRaw = body.lastWatchedSec;
  const progressPct = Number(pctRaw);
  const lastWatchedSec = Number(secRaw);

  if (!Number.isFinite(progressPct) || progressPct < 0 || progressPct > 100) {
    return { ok: false, code: 'INVALID_PROGRESS', message: 'progressPct must be a number between 0 and 100' };
  }
  // Coerce to int (the column is Int) — fractional values from getCurrentTime/duration
  // land in the same pixel; we round once and the rest is server-side clamp.
  const pct = Math.round(progressPct);

  if (!Number.isFinite(lastWatchedSec) || lastWatchedSec < 0) {
    return { ok: false, code: 'INVALID_WATCHED_SEC', message: 'lastWatchedSec must be a non-negative number' };
  }
  const sec = Math.floor(lastWatchedSec);

  // Monotonic guard with a small tolerance for resume-after-reload drift.
  // If the client reports a value that's > 5 lower than what we have,
  // either the browser is replaying a stale cached event or someone is
  // trying to fake completion by jumping back; reject.
  if (pct + 5 < previousPct) {
    return {
      ok: false,
      code: 'PROGRESS_REGRESSED',
      message: 'progressPct went backwards by more than the allowed tolerance',
    };
  }

  let evidenceMetadata = null;
  if (body.evidenceMetadata != null) {
    if (typeof body.evidenceMetadata !== 'object') {
      return { ok: false, code: 'INVALID_METADATA', message: 'evidenceMetadata must be an object' };
    }
    evidenceMetadata = body.evidenceMetadata;
  }

  return {
    ok: true,
    value: {
      progressPct: pct,
      lastWatchedSec: sec,
      evidenceMetadata,
    },
  };
}

// DR-010 (round-20): decides if `progressPct >= 100` is allowed to auto-
// promote an enrollment to a PLAYER_OBSERVED_COMPLETED state, given the
// course provider. YOUTUBE and VIMEO are player-observable; the others
// have no working IFrame API and so the auto-complete path is not
// available — those courses are completed via admin override or the
// employee's manual "I'm done" click (SELF_ATTESTED).
function canAutoCompleteFromPlayer(provider) {
  return provider === 'YOUTUBE' || provider === 'VIMEO';
}

// Validate the body for PUT /api/training/enrollments/:id/complete
// (employee manual mark-complete OR admin override).
//
// Round-20 (DR-010): adds `evidenceClass` to let callers explicitly tag
// which completion path they're invoking. The route handler resolves the
// default (SELF_ATTESTED for the employee self-click, ADMIN_OVERRIDE for
// the admin path) if the caller leaves it null.
function validateCompletePayload(body) {
  if (body == null) return { ok: true, value: { note: null, evidenceClass: null, reason: null, evidenceMetadata: null } };
  if (typeof body !== 'object') {
    return { ok: false, code: 'INVALID_BODY', message: 'Body required' };
  }
  let note = null;
  if (body.note != null) {
    if (typeof body.note !== 'string') {
      return { ok: false, code: 'INVALID_NOTE', message: 'note must be a string or null' };
    }
    note = body.note.trim() || null;
    if (note && note.length > MAX_EMPLOYEE_NOTE_LEN) {
      return {
        ok: false,
        code: 'NOTE_TOO_LONG',
        message: `note must be at most ${MAX_EMPLOYEE_NOTE_LEN} characters`,
      };
    }
  }
  let evidenceClass = null;
  if (body.evidenceClass != null) {
    if (typeof body.evidenceClass !== 'string' || !EVIDENCE_CLASSES.has(body.evidenceClass)) {
      return {
        ok: false,
        code: 'INVALID_EVIDENCE_CLASS',
        message: `evidenceClass must be one of: ${[...EVIDENCE_CLASSES].join(', ')}`,
      };
    }
    evidenceClass = body.evidenceClass;
  }
  let reason = null;
  if (body.reason != null) {
    if (typeof body.reason !== 'string') {
      return { ok: false, code: 'INVALID_REASON', message: 'reason must be a string or null' };
    }
    reason = body.reason.trim() || null;
    if (reason && reason.length > MAX_EMPLOYEE_NOTE_LEN) {
      return {
        ok: false,
        code: 'REASON_TOO_LONG',
        message: `reason must be at most ${MAX_EMPLOYEE_NOTE_LEN} characters`,
      };
    }
  }
  let evidenceMetadata = null;
  if (body.evidenceMetadata != null) {
    if (typeof body.evidenceMetadata !== 'object' || Array.isArray(body.evidenceMetadata)) {
      return { ok: false, code: 'INVALID_METADATA', message: 'evidenceMetadata must be a JSON object' };
    }
    evidenceMetadata = body.evidenceMetadata;
  }
  return {
    ok: true,
    value: { note, evidenceClass, reason, evidenceMetadata },
  };
}

// Validate the body for POST /api/training/enrollments/:id/cancel.
// Round-24 follow-up to the edit/reassign work: the only field the admin
// sends is an optional reason (stored in employeeNote). The route enforces
// the actual transition against canTransition() + a status
// `notIn: completed-states` clause, so the validator's job is just shape
// + length checks; the business rules live in the route + state machine.
function validateCancelPayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, code: 'INVALID_BODY', message: 'Body required' };
  }
  let note = null;
  if (body.note != null) {
    if (typeof body.note !== 'string') {
      return { ok: false, code: 'INVALID_NOTE', message: 'note must be a string or null' };
    }
    note = body.note.trim() || null;
    if (note && note.length > MAX_EMPLOYEE_NOTE_LEN) {
      return {
        ok: false,
        code: 'NOTE_TOO_LONG',
        message: `note must be at most ${MAX_EMPLOYEE_NOTE_LEN} characters`,
      };
    }
  }
  return { ok: true, value: { note } };
}

// DR-010 (round-20): given an existing enrollment and a chosen evidence
// class, return the data patch that the route handler should pass to
// Prisma.update. Pure function — no I/O. The route handler is responsible
// for (a) locking the row from concurrent writes, (b) writing the audit
// log, (c) emitting the notification.
//
// Inputs:
//   enrollment — { status, evidenceClass, progressPct, employeeId, ...}
//   evidence   — { evidenceClass, completedBy, evidenceMetadata, providerSessionId }
//   actorId    — employeeId of the requester (used to default SELF_ATTESTED's completedBy)
//
// Returns: { status, progressPct, completedAt, startedAt?, evidenceClass,
//           completedBy, evidenceMetadata, providerSessionId }
function markComplete(enrollment, evidence, actorId) {
  const evidenceClass = evidence.evidenceClass
    || (enrollment.employeeId === actorId ? 'SELF_ATTESTED' : 'ADMIN_OVERRIDE');
  if (!EVIDENCE_CLASSES.has(evidenceClass)) {
    throw new Error(`Unknown evidenceClass: ${evidenceClass}`);
  }
  const status = EVIDENCE_TO_STATUS[evidenceClass];
  const now = new Date();
  return {
    status,
    progressPct: 100,
    completedAt: now,
    startedAt: enrollment.startedAt || now,
    evidenceClass,
    completedBy: evidence.completedBy || actorId,
    evidenceMetadata: evidence.evidenceMetadata || null,
    providerSessionId: evidence.providerSessionId || null,
  };
}

// Status transitions the system can perform:
//
//   ASSIGNED    → IN_PROGRESS              (first progress ping with progressPct > 0)
//   ASSIGNED    → SELF_ATTESTED_COMPLETED  (employee manual "I'm done")
//   ASSIGNED    → ADMIN_OVERRIDE_COMPLETED (admin override path)
//   IN_PROGRESS → PLAYER_OBSERVED_COMPLETED (player reached ended=true)
//   IN_PROGRESS → SELF_ATTESTED_COMPLETED  (employee manual on a non-video course)
//   IN_PROGRESS → ADMIN_OVERRIDE_COMPLETED (admin override)
//   ANY_COMPLETED → same value             (idempotent — re-write is a noop)
//
// All other transitions are invalid. Completed-states are terminal in v1.
function canTransition(fromStatus, toStatus) {
  if (!ALLOWED_STATUSES.has(fromStatus)) return false;
  if (!ALLOWED_STATUSES.has(toStatus)) return false;
  if (fromStatus === toStatus) return true; // idempotent writes

  if (isCompleted(fromStatus)) return false; // completed is terminal

  if (fromStatus === 'ASSIGNED') {
    // Round-24: admin can unassign before the learner starts (CANCELLED
    // branch added). The route also enforces the same terminal-state guard
    // (`status: { notIn: completed-states }` in the where clause) so two
    // admins racing on the same row get a clean 409, not a silent overwrite.
    return toStatus === 'IN_PROGRESS'
      || toStatus === 'SELF_ATTESTED_COMPLETED'
      || toStatus === 'PLAYER_OBSERVED_COMPLETED'
      || toStatus === 'ADMIN_OVERRIDE_COMPLETED'
      || toStatus === 'CANCELLED';
  }
  if (fromStatus === 'IN_PROGRESS') {
    return toStatus === 'SELF_ATTESTED_COMPLETED'
      || toStatus === 'PLAYER_OBSERVED_COMPLETED'
      || toStatus === 'PROVIDER_VERIFIED_COMPLETED'
      || toStatus === 'ADMIN_OVERRIDE_COMPLETED'
      // Round-24: admin can unassign an in-progress learner (employee
      // already started, admin pulls the row).
      || toStatus === 'CANCELLED';
  }
  // OVERDUE: rolled into "admin can pull it back" (round-24). The route
  // refuses the row-update if status is currently in a completed-state, so
  // OVERDUE→CANCELLED here is safe and lets the admin clean up stale
  // assignments without touching completed ones.
  if (fromStatus === 'OVERDUE') {
    return toStatus === 'CANCELLED';
  }
  // CANCELLED: terminal. Re-opening is post-v1 (would need an audit trail
  // of who reopened and why; out of scope for the round-24 cancel button).
  return false;
}

// Map a rule-failure code to an HTTP status.
function httpStatusForCode(code) {
  switch (code) {
    case 'INVALID_BODY':
    case 'INVALID_TITLE':
    case 'TITLE_TOO_LONG':
    case 'INVALID_DESCRIPTION':
    case 'DESCRIPTION_TOO_LONG':
    case 'INVALID_CATEGORY':
    case 'CATEGORY_TOO_LONG':
    case 'INVALID_URL':
    case 'INVALID_URL_SCHEME':
    case 'URL_TOO_LONG':
    case 'INVALID_PROVIDER':
    case 'INVALID_DURATION':
    case 'INVALID_COURSE_ID':
    case 'INVALID_EMPLOYEE_IDS':
    case 'INVALID_EMPLOYEE_ID':
    case 'NO_EMPLOYEES':
    case 'TOO_MANY_EMPLOYEES':
    case 'INVALID_DUE_DATE':
    case 'INVALID_PRIORITY':
    case 'INVALID_PROGRESS':
    case 'INVALID_WATCHED_SEC':
    case 'INVALID_NOTE':
    case 'NOTE_TOO_LONG':
    case 'INVALID_EVIDENCE_CLASS':
    case 'INVALID_REASON':
    case 'REASON_TOO_LONG':
    case 'INVALID_METADATA':
    case 'EVIDENCE_REQUIRED':
    case 'PLAYER_DATA_REQUIRED':
    case 'UNKNOWN_FIELDS':
    case 'NO_CHANGES':
      return 400;
    case 'NOT_FOUND':
      return 404;
    case 'FORBIDDEN':
      return 403;
    case 'DUPLICATE':
    case 'PROGRESS_REGRESSED':
    case 'ENROLLMENT_LOCKED':
      return 409;
    default:
      return 400;
  }
}

module.exports = {
  ALLOWED_PROVIDERS,
  ALLOWED_STATUSES,
  EVIDENCE_CLASSES,
  EVIDENCE_TO_STATUS,
  STATUS_TO_EVIDENCE,
  ALLOWED_PRIORITIES,
  ALLOWED_COURSE_UPDATE_FIELDS,
  MAX_TITLE_LEN,
  MAX_DESCRIPTION_LEN,
  MAX_CATEGORY_LEN,
  MAX_EMPLOYEE_NOTE_LEN,
  MAX_URL_LEN,
  MAX_EMPLOYEE_IDS_PER_BULK,
  detectProviderFromUrl,
  extractYouTubeId,
  extractVimeoId,
  parseExternalUrl,
  validateCreateCourse,
  validateUpdateCourse,
  validateAssignEnrollments,
  validateProgressPayload,
  validateCompletePayload,
  validateCancelPayload,
  canTransition,
  canAutoCompleteFromPlayer,
  isCompleted,
  TERMINAL_STATUSES,
  TERMINAL_STATUS_SET,
  markComplete,
  httpStatusForCode,
};