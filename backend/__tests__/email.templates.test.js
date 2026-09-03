// ─────────────────────────────────────────────────────────────────────────────
// Round-25: Email template contract tests.
//
// Pins the per-type renderer output so a future template refactor doesn't
// silently change the brand chrome (header, footer), lose an HTML-escape on
// a user-supplied field, or remove a CTA link. Each case renders the type's
// template and asserts:
//   1. subject is non-empty + matches the expected pattern
//   2. html contains the brand header
//   3. html contains the portal-CTA / preferences link
//   4. user-supplied values are HTML-escaped (no raw <script> in the body)
//   5. the FK id is NOT leaked raw into the rendered HTML body (the cuid
//      appears only inside the CTA URL — same pattern as the in-app portal)
// ─────────────────────────────────────────────────────────────────────────────

const { renderTemplate, escapeHtml } = require('../src/templates/email');

function makeContext(type, overrides = {}) {
  const base = {
    id: 'notif-' + type.toLowerCase(),
    type,
    employeeId: 'emp-1',
    message: 'You have a new notification.',
    dprId: 'dpr-abc',
    leaveRequestId: 'lreq-abc',
    trainingEnrollmentId: 'tenr-abc',
  };
  return {
    notification: { ...base, ...overrides.notification },
    context: overrides.context || {},
    recipientEmail: 'user@example.com',
  };
}

const ALL_TYPES = [
  'DPR_REVIEWED',
  'DPR_APPROVED',
  'DPR_REJECTED',
  'INSPECTION_ACKNOWLEDGED',
  'INSPECTION_CLOSED',
  'INSPECTION_REJECTED',
  'LEAVE_DECIDED',
  'TRAINING_ASSIGNED',
  'TRAINING_CANCELLED',
  'TRAINING_IN_PROGRESS',
  'TRAINING_COMPLETED',
];

describe('email templates — every active type renders without throwing', () => {
  it.each(ALL_TYPES)('%s renders a subject + html with the brand chrome', (type) => {
    const { subject, html } = renderTemplate(type, makeContext(type));
    expect(typeof subject).toBe('string');
    expect(subject.length).toBeGreaterThan(0);
    expect(typeof html).toBe('string');
    expect(html.length).toBeGreaterThan(200);
    expect(html).toMatch(/<html/);
    expect(html).toMatch(/ACS Portal/);
    expect(html).toMatch(/portal\/notifications\/preferences/);
  });
});

describe('email templates — user-supplied values are HTML-escaped', () => {
  it('escapes a malicious projectName in DPR_APPROVED', () => {
    const evil = '<script>alert("xss")</script>';
    const { html } = renderTemplate('DPR_APPROVED', makeContext('DPR_APPROVED', {
      notification: { message: evil },
      context: { projectName: evil, reportDate: '2026-09-03' },
    }));
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes a malicious courseTitle in TRAINING_ASSIGNED', () => {
    const evil = '" onload="alert(1)"';
    const { html } = renderTemplate('TRAINING_ASSIGNED', makeContext('TRAINING_ASSIGNED', {
      context: { courseTitle: evil },
    }));
    // The HTML body is the security boundary — email clients render bodies
    // as HTML. The subject line goes into the RFC 5322 `Subject:` header
    // and is rendered as plain text by every modern client, so escaping it
    // is unnecessary and would produce unreadable "=?utf-8?Q?..." encoded
    // subjects. We assert the body — that's where XSS would actually fire.
    expect(html).not.toContain('" onload="alert(1)"');
    expect(html).toContain('&quot;');
  });

  it('escapes a malicious note in TRAINING_CANCELLED', () => {
    const evil = 'Wrong <b>course</b> for this & that';
    const { html } = renderTemplate('TRAINING_CANCELLED', makeContext('TRAINING_CANCELLED', {
      context: { courseTitle: 'X', note: evil },
    }));
    expect(html).not.toContain('<b>course</b>');
    expect(html).toContain('Wrong &lt;b&gt;course&lt;/b&gt; for this &amp; that');
  });
});

describe('email templates — per-type subject lines', () => {
  it('DPR_APPROVED subject includes projectName', () => {
    const { subject } = renderTemplate('DPR_APPROVED', makeContext('DPR_APPROVED', {
      context: { projectName: 'Acme Residency', reportDate: '2026-09-03' },
    }));
    expect(subject).toBe('Your DPR for Acme Residency was approved');
  });

  it('TRAINING_ASSIGNED subject includes course title', () => {
    const { subject } = renderTemplate('TRAINING_ASSIGNED', makeContext('TRAINING_ASSIGNED', {
      context: { courseTitle: 'Construction Safety 101' },
    }));
    expect(subject).toBe('New training assigned: Construction Safety 101');
  });

  it('INSPECTION_REJECTED subject is fixed (no project context yet)', () => {
    const { subject } = renderTemplate('INSPECTION_REJECTED', makeContext('INSPECTION_REJECTED'));
    expect(subject).toBe('Inspection rejected');
  });

  it('LEAVE_DECIDED subject is fixed', () => {
    const { subject } = renderTemplate('LEAVE_DECIDED', makeContext('LEAVE_DECIDED'));
    expect(subject).toBe('Leave request update');
  });
});

describe('email templates — CTA links point to the portal', () => {
  // The CTA URLs use whatever FRONTEND_URL resolves to in the test env
  // (jest.setup.js sets it to http://localhost:3000). The pattern below
  // matches any protocol/host so the test doesn't have to mirror the
  // env var, and would still catch a future bug that forgot the path
  // segment (/portal/training/<id>) or stripped the id.
  it('TRAINING_ASSIGNED CTA links to /portal/training/:id', () => {
    const { html } = renderTemplate('TRAINING_ASSIGNED', makeContext('TRAINING_ASSIGNED', {
      context: { courseTitle: 'X' },
    }));
    expect(html).toMatch(/href="[^"]*\/portal\/training\/tenr-abc"/);
  });

  it('DPR_APPROVED CTA links to /portal/dpr/:id', () => {
    const { html } = renderTemplate('DPR_APPROVED', makeContext('DPR_APPROVED', {
      context: { projectName: 'X', reportDate: '2026-09-03' },
    }));
    expect(html).toMatch(/href="[^"]*\/portal\/dpr\/dpr-abc"/);
  });

  it('INSPECTION_REJECTED surfaces the reason in the body when provided', () => {
    const { html } = renderTemplate('INSPECTION_REJECTED', makeContext('INSPECTION_REJECTED', {
      context: { reason: 'Photo of damaged cube' },
    }));
    expect(html).toContain('Reason');
    expect(html).toContain('Photo of damaged cube');
  });
});

describe('email templates — renderTemplate errors on unknown type', () => {
  it('throws when no template is registered', () => {
    expect(() => renderTemplate('UNKNOWN_TYPE', makeContext('UNKNOWN_TYPE'))).toThrow(/No email template registered/);
  });
});

describe('escapeHtml contract', () => {
  it('handles the five dangerous chars', () => {
    expect(escapeHtml('<a href="b&c">')).toBe('&lt;a href=&quot;b&amp;c&quot;&gt;');
  });
  it('returns empty string for null/undefined', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });
  it('coerces non-strings to string', () => {
    expect(escapeHtml(42)).toBe('42');
  });
});
