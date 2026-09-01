/**
 * Backend tests for the Training module (Round-14).
 *
 * This file tests ONLY the pure validators and shared error helpers in
 * the training module. The route handlers in src/routes/training.js are
 * thin wrappers around the same validators plus a Prisma client — the
 * same pattern is exercised by __tests__/attendance.test.js and
 * __tests__/leave.test.js, so we get high confidence without the cost
 * of spinning up a mock-Prisma test harness for every endpoint here.
 *
 * Pure-validator tests are fast, deterministic, and don't depend on
 * Express / Prisma being loaded — important in sandboxed CI where
 * loading the full `express` package from node_modules can take
 * noticeably longer than the test timeout.
 */

const {
  detectProviderFromUrl,
  extractYouTubeId,
  extractVimeoId,
  parseExternalUrl,
  validateCreateCourse,
  validateUpdateCourse,
  validateAssignEnrollments,
  validateProgressPayload,
  validateCompletePayload,
  canTransition,
  httpStatusForCode,
  ALLOWED_PROVIDERS,
  ALLOWED_STATUSES,
  ALLOWED_PRIORITIES,
  ALLOWED_COURSE_UPDATE_FIELDS,
  MAX_TITLE_LEN,
  MAX_DESCRIPTION_LEN,
  MAX_CATEGORY_LEN,
  MAX_EMPLOYEE_NOTE_LEN,
  MAX_URL_LEN,
  MAX_EMPLOYEE_IDS_PER_BULK,
} = require('../src/lib/trainingRules');

// ─────────────────────────────────────────────────────────────────────────────
// Provider detection
// ─────────────────────────────────────────────────────────────────────────────

describe('trainingRules — detectProviderFromUrl', () => {
  it('detects YouTube from common URL shapes', () => {
    expect(detectProviderFromUrl('https://www.youtube.com/watch?v=abc123def45')).toBe('YOUTUBE');
    expect(detectProviderFromUrl('https://youtu.be/abc123def45')).toBe('YOUTUBE');
    expect(detectProviderFromUrl('https://www.youtube.com/embed/abc123def45')).toBe('YOUTUBE');
    expect(detectProviderFromUrl('https://www.youtube.com/shorts/abc123def45')).toBe('YOUTUBE');
    expect(detectProviderFromUrl('https://m.youtube.com/watch?v=abc123def45')).toBe('YOUTUBE');
    expect(detectProviderFromUrl('https://www.youtube-nocookie.com/embed/abc123def45')).toBe('YOUTUBE');
  });

  it('detects Vimeo', () => {
    expect(detectProviderFromUrl('https://vimeo.com/123456789')).toBe('VIMEO');
    expect(detectProviderFromUrl('https://player.vimeo.com/video/123456789')).toBe('VIMEO');
  });

  it('detects LinkedIn Learning', () => {
    expect(detectProviderFromUrl('https://www.linkedin.com/learning/some-course')).toBe('LINKEDIN_LEARNING');
  });

  it('detects Coursera and Udemy', () => {
    expect(detectProviderFromUrl('https://www.coursera.org/learn/some-course')).toBe('COURSERA');
    expect(detectProviderFromUrl('https://www.udemy.com/course/some-course')).toBe('UDEMY');
  });

  it('returns null for unknown providers or invalid input', () => {
    expect(detectProviderFromUrl('https://example.com/foo')).toBe(null);
    expect(detectProviderFromUrl('not a url')).toBe(null);
    expect(detectProviderFromUrl(null)).toBe(null);
    expect(detectProviderFromUrl(undefined)).toBe(null);
    expect(detectProviderFromUrl(42)).toBe(null);
  });

  it('rejects non-http(s) schemes', () => {
    expect(detectProviderFromUrl('javascript:alert(1)')).toBe(null);
    expect(detectProviderFromUrl('ftp://example.com/foo.mp4')).toBe(null);
    expect(detectProviderFromUrl('file:///etc/passwd')).toBe(null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// YouTube / Vimeo ID extraction
// ─────────────────────────────────────────────────────────────────────────────

describe('trainingRules — extractYouTubeId', () => {
  it('pulls the v= query param', () => {
    expect(extractYouTubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });
  it('pulls from youtu.be short URL', () => {
    expect(extractYouTubeId('https://youtu.be/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });
  it('pulls from /embed/ path', () => {
    expect(extractYouTubeId('https://www.youtube.com/embed/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });
  it('pulls from /shorts/ path', () => {
    expect(extractYouTubeId('https://www.youtube.com/shorts/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });
  it('returns null for non-YouTube URLs', () => {
    expect(extractYouTubeId('https://vimeo.com/12345')).toBe(null);
    expect(extractYouTubeId('https://example.com')).toBe(null);
    expect(extractYouTubeId('not a url')).toBe(null);
  });
});

describe('trainingRules — extractVimeoId', () => {
  it('extracts numeric ID from vimeo.com/<id>', () => {
    expect(extractVimeoId('https://vimeo.com/123456789')).toBe('123456789');
  });
  it('extracts numeric ID from player.vimeo.com/video/<id>', () => {
    expect(extractVimeoId('https://player.vimeo.com/video/123456789')).toBe('123456789');
  });
  it('returns null for non-numeric / non-vimeo URLs', () => {
    expect(extractVimeoId('https://vimeo.com/about')).toBe(null);
    expect(extractVimeoId('https://youtube.com/watch?v=foo')).toBe(null);
    expect(extractVimeoId('not a url')).toBe(null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseExternalUrl
// ─────────────────────────────────────────────────────────────────────────────

describe('trainingRules — parseExternalUrl', () => {
  it('accepts valid http(s) URLs and returns the detected provider', () => {
    const r = parseExternalUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(r.ok).toBe(true);
    expect(r.value).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(r.provider).toBe('YOUTUBE');
  });

  it('rejects empty / non-string / over-length input', () => {
    expect(parseExternalUrl('').ok).toBe(false);
    expect(parseExternalUrl(null).ok).toBe(false);
    expect(parseExternalUrl(42).ok).toBe(false);
    expect(parseExternalUrl('https://example.com/' + 'a'.repeat(3000)).ok).toBe(false);
  });

  it('rejects non-http(s) schemes', () => {
    expect(parseExternalUrl('javascript:alert(1)').ok).toBe(false);
    expect(parseExternalUrl('ftp://example.com/foo').ok).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validateCreateCourse
// ─────────────────────────────────────────────────────────────────────────────

describe('trainingRules — validateCreateCourse', () => {
  const goodBody = {
    title: 'Project Safety Essentials',
    description: 'Intro to safety on construction sites.',
    externalUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    category: 'Safety',
    durationHint: 600,
  };

  it('accepts a well-formed payload', () => {
    const r = validateCreateCourse(goodBody);
    expect(r.ok).toBe(true);
    expect(r.value.title).toBe('Project Safety Essentials');
    expect(r.value.provider).toBe('YOUTUBE'); // auto-detected
    expect(r.value.category).toBe('Safety');
  });

  it('rejects missing title', () => {
    const r = validateCreateCourse({ ...goodBody, title: '' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('INVALID_TITLE');
  });

  it('rejects over-long title', () => {
    const r = validateCreateCourse({ ...goodBody, title: 'a'.repeat(MAX_TITLE_LEN + 1) });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('TITLE_TOO_LONG');
  });

  it('rejects invalid URL', () => {
    const r = validateCreateCourse({ ...goodBody, externalUrl: 'not-a-url' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('INVALID_URL');
  });

  it('rejects javascript: scheme', () => {
    const r = validateCreateCourse({ ...goodBody, externalUrl: 'javascript:alert(1)' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('INVALID_URL_SCHEME');
  });

  it('accepts admin-supplied provider override', () => {
    const r = validateCreateCourse({ ...goodBody, provider: 'OTHER' });
    expect(r.ok).toBe(true);
    expect(r.value.provider).toBe('OTHER');
  });

  it('rejects invalid provider string', () => {
    const r = validateCreateCourse({ ...goodBody, provider: 'SPOTIFY' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('INVALID_PROVIDER');
  });

  it('defaults provider to OTHER for unrecognized URLs', () => {
    const r = validateCreateCourse({ ...goodBody, externalUrl: 'https://example.com/course' });
    expect(r.ok).toBe(true);
    expect(r.value.provider).toBe('OTHER');
  });

  it('rejects negative or absurd durationHint', () => {
    expect(validateCreateCourse({ ...goodBody, durationHint: -1 }).ok).toBe(false);
    expect(validateCreateCourse({ ...goodBody, durationHint: 999999 }).ok).toBe(false);
    expect(validateCreateCourse({ ...goodBody, durationHint: 'abc' }).ok).toBe(false);
  });

  it('enforces MAX_DESCRIPTION_LEN', () => {
    const r = validateCreateCourse({ ...goodBody, description: 'a'.repeat(MAX_DESCRIPTION_LEN + 1) });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('DESCRIPTION_TOO_LONG');
  });

  it('enforces MAX_CATEGORY_LEN', () => {
    const r = validateCreateCourse({ ...goodBody, category: 'a'.repeat(MAX_CATEGORY_LEN + 1) });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('CATEGORY_TOO_LONG');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validateUpdateCourse
// ─────────────────────────────────────────────────────────────────────────────

describe('trainingRules — validateUpdateCourse', () => {
  it('accepts a known field', () => {
    const r = validateUpdateCourse({ title: 'New Title' });
    expect(r.ok).toBe(true);
    expect(r.value.title).toBe('New Title');
  });

  it('rejects unknown fields (strict PUT)', () => {
    const r = validateUpdateCourse({ title: 'ok', bogus: 1 });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('UNKNOWN_FIELDS');
  });

  it('rejects empty body', () => {
    const r = validateUpdateCourse({});
    expect(r.ok).toBe(false);
    expect(r.code).toBe('NO_CHANGES');
  });

  it('accepts isArchived boolean', () => {
    const r = validateUpdateCourse({ isArchived: true });
    expect(r.ok).toBe(true);
    expect(r.value.isArchived).toBe(true);
  });

  it('rejects invalid URL on update', () => {
    const r = validateUpdateCourse({ externalUrl: 'javascript:alert(1)' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('INVALID_URL_SCHEME');
  });

  it('ALLOWED_COURSE_UPDATE_FIELDS is the strict allowlist', () => {
    expect(ALLOWED_COURSE_UPDATE_FIELDS).toEqual(expect.arrayContaining([
      'title', 'description', 'externalUrl', 'provider', 'category', 'durationHint', 'isArchived',
    ]));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validateAssignEnrollments
// ─────────────────────────────────────────────────────────────────────────────

describe('trainingRules — validateAssignEnrollments', () => {
  const goodBody = {
    courseId: 'course-1',
    employeeIds: ['emp-1', 'emp-2', 'emp-3'],
    dueDate: '2026-12-31',
    priority: 'HIGH',
  };

  it('accepts a well-formed bulk-assign payload', () => {
    const r = validateAssignEnrollments(goodBody);
    expect(r.ok).toBe(true);
    expect(r.value.employeeIds.length).toBe(3);
    expect(r.value.priority).toBe('HIGH');
    expect(r.value.dueDate instanceof Date).toBe(true);
  });

  it('rejects missing courseId', () => {
    const r = validateAssignEnrollments({ ...goodBody, courseId: '' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('INVALID_COURSE_ID');
  });

  it('rejects non-array employeeIds', () => {
    const r = validateAssignEnrollments({ ...goodBody, employeeIds: 'emp-1' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('INVALID_EMPLOYEE_IDS');
  });

  it('rejects empty employeeIds', () => {
    const r = validateAssignEnrollments({ ...goodBody, employeeIds: [] });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('NO_EMPLOYEES');
  });

  it('dedupes duplicate employee IDs in payload', () => {
    const r = validateAssignEnrollments({ ...goodBody, employeeIds: ['a', 'b', 'a', 'c', 'b'] });
    expect(r.ok).toBe(true);
    expect(r.value.employeeIds).toEqual(['a', 'b', 'c']);
  });

  it('rejects over-long bulk request', () => {
    const r = validateAssignEnrollments({
      ...goodBody,
      employeeIds: Array.from({ length: MAX_EMPLOYEE_IDS_PER_BULK + 1 }, (_, i) => `emp-${i}`),
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('TOO_MANY_EMPLOYEES');
  });

  it('rejects invalid dueDate', () => {
    expect(validateAssignEnrollments({ ...goodBody, dueDate: 'tomorrow' }).ok).toBe(false);
    expect(validateAssignEnrollments({ ...goodBody, dueDate: '2026-02-30' }).ok).toBe(false); // rollover
  });

  it('rejects invalid priority', () => {
    expect(validateAssignEnrollments({ ...goodBody, priority: 'URGENT' }).ok).toBe(false);
  });

  it('defaults priority to NORMAL', () => {
    const r = validateAssignEnrollments({ ...goodBody, priority: undefined });
    expect(r.ok).toBe(true);
    expect(r.value.priority).toBe('NORMAL');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validateProgressPayload
// ─────────────────────────────────────────────────────────────────────────────

describe('trainingRules — validateProgressPayload', () => {
  it('accepts valid in-range values', () => {
    const r = validateProgressPayload({ progressPct: 47.6, lastWatchedSec: 120 }, 30);
    expect(r.ok).toBe(true);
    expect(r.value.progressPct).toBe(48); // rounded
    expect(r.value.lastWatchedSec).toBe(120);
  });

  it('rejects out-of-range pct', () => {
    expect(validateProgressPayload({ progressPct: -1, lastWatchedSec: 1 }, 0).ok).toBe(false);
    expect(validateProgressPayload({ progressPct: 101, lastWatchedSec: 1 }, 0).ok).toBe(false);
  });

  it('rejects non-numeric pct', () => {
    expect(validateProgressPayload({ progressPct: 'abc', lastWatchedSec: 0 }, 0).ok).toBe(false);
  });

  it('rejects negative lastWatchedSec', () => {
    expect(validateProgressPayload({ progressPct: 50, lastWatchedSec: -5 }, 0).ok).toBe(false);
  });

  it('allows a 5% backward step (refresh tolerance)', () => {
    const r = validateProgressPayload({ progressPct: 48, lastWatchedSec: 100 }, 50);
    expect(r.ok).toBe(true);
  });

  it('rejects a > 5% backward step (regression guard)', () => {
    const r = validateProgressPayload({ progressPct: 30, lastWatchedSec: 60 }, 50);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('PROGRESS_REGRESSED');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validateCompletePayload
// ─────────────────────────────────────────────────────────────────────────────

describe('trainingRules — validateCompletePayload', () => {
  it('accepts null/empty body (no note)', () => {
    expect(validateCompletePayload(null).ok).toBe(true);
    expect(validateCompletePayload({}).ok).toBe(true);
    expect(validateCompletePayload({}).value.note).toBe(null);
  });

  it('accepts a short note', () => {
    const r = validateCompletePayload({ note: 'finished it' });
    expect(r.ok).toBe(true);
    expect(r.value.note).toBe('finished it');
  });

  it('rejects over-long note', () => {
    const r = validateCompletePayload({ note: 'a'.repeat(MAX_EMPLOYEE_NOTE_LEN + 1) });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('NOTE_TOO_LONG');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// canTransition
// ─────────────────────────────────────────────────────────────────────────────

describe('trainingRules — canTransition', () => {
  it('allows ASSIGNED → IN_PROGRESS', () => {
    expect(canTransition('ASSIGNED', 'IN_PROGRESS')).toBe(true);
  });
  it('allows ASSIGNED → COMPLETED', () => {
    expect(canTransition('ASSIGNED', 'COMPLETED')).toBe(true);
  });
  it('allows IN_PROGRESS → COMPLETED', () => {
    expect(canTransition('IN_PROGRESS', 'COMPLETED')).toBe(true);
  });
  it('allows idempotent same-status writes', () => {
    expect(canTransition('IN_PROGRESS', 'IN_PROGRESS')).toBe(true);
    expect(canTransition('ASSIGNED', 'ASSIGNED')).toBe(true);
  });
  it('forbids backward transitions', () => {
    expect(canTransition('IN_PROGRESS', 'ASSIGNED')).toBe(false);
  });
  it('forbids transitions out of COMPLETED', () => {
    expect(canTransition('COMPLETED', 'IN_PROGRESS')).toBe(false);
    expect(canTransition('COMPLETED', 'ASSIGNED')).toBe(false);
  });
  it('forbids transitions from unknown statuses', () => {
    expect(canTransition('UNKNOWN', 'ASSIGNED')).toBe(false);
    expect(canTransition('ASSIGNED', 'UNKNOWN')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// httpStatusForCode
// ─────────────────────────────────────────────────────────────────────────────

describe('trainingRules — httpStatusForCode', () => {
  it('maps 400 validation codes', () => {
    expect(httpStatusForCode('INVALID_TITLE')).toBe(400);
    expect(httpStatusForCode('INVALID_URL')).toBe(400);
    expect(httpStatusForCode('TITLE_TOO_LONG')).toBe(400);
    expect(httpStatusForCode('NO_CHANGES')).toBe(400);
  });
  it('maps 409 conflict codes', () => {
    expect(httpStatusForCode('DUPLICATE')).toBe(409);
    expect(httpStatusForCode('ENROLLMENT_LOCKED')).toBe(409);
    expect(httpStatusForCode('PROGRESS_REGRESSED')).toBe(409);
  });
  it('maps NOT_FOUND to 404', () => {
    expect(httpStatusForCode('NOT_FOUND')).toBe(404);
  });
  it('maps FORBIDDEN to 403', () => {
    expect(httpStatusForCode('FORBIDDEN')).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Allowlist constants — sanity
// ─────────────────────────────────────────────────────────────────────────────

describe('trainingRules — allowlist constants', () => {
  it('ALLOWED_PROVIDERS has the documented set', () => {
    expect(ALLOWED_PROVIDERS).toEqual(new Set([
      'YOUTUBE', 'VIMEO', 'LINKEDIN_LEARNING', 'COURSERA', 'UDEMY', 'OTHER',
    ]));
  });
  it('ALLOWED_STATUSES has ASSIGNED / IN_PROGRESS / COMPLETED', () => {
    expect(ALLOWED_STATUSES).toEqual(new Set(['ASSIGNED', 'IN_PROGRESS', 'COMPLETED']));
  });
  it('ALLOWED_PRIORITIES has LOW / NORMAL / HIGH', () => {
    expect(ALLOWED_PRIORITIES).toEqual(new Set(['LOW', 'NORMAL', 'HIGH']));
  });
  it('MAX_URL_LEN is 2048', () => {
    expect(MAX_URL_LEN).toBe(2048);
  });
  it('MAX_TITLE_LEN is 160', () => {
    expect(MAX_TITLE_LEN).toBe(160);
  });
  it('MAX_EMPLOYEE_IDS_PER_BULK is 500', () => {
    expect(MAX_EMPLOYEE_IDS_PER_BULK).toBe(500);
  });
});
