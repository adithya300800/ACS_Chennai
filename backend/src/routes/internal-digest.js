// Round-25 (M2): Daily digest cron handler.
//
// Endpoint:
//   POST /api/internal/digest/run
//     Header: X-Internal-Token: <INTERNAL_API_TOKEN>
//     Optional: ?date=YYYY-MM-DD  (for backfill / dry-runs; default = today IST)
//
// Architecture:
//   The Render Cron Job fires this endpoint at 02:30 UTC (= 08:00 IST) every
//   day. For each employee with `digestEnabled=true` and at least one
//   unread digest-type notification in the last 24h, we render a grouped
//   digest email and send via Zoho SMTP. A `DigestRun` row pins idempotency
//   so a re-fire within the same business date is a no-op.
//
// Idempotency:
//   `DigestRun.@@unique([employeeId, scheduledFor])` is the source of truth.
//   We use a try/catch on P2002 to detect "already-completed" and exit early
//   for that employee. A FAILED run for the same date is deleted and
//   retried — operators want a transient SMTP outage at 8:01 to NOT
//   permanently block today's digest.
//
// Time window:
//   scheduledFor = today's date at 00:00 IST (UTC: previous-day 18:30)
//   window = [scheduledFor - 24h, scheduledFor]
//   The digest thus covers "yesterday's" notifications in IST. Anything
//   created after midnight rolls into the next day's digest.

'use strict';

const express = require('express');
const router = express.Router();
const { sendEmail, isConfigured } = require('../lib/email');
const { renderDigestTemplate } = require('../templates/email');
const { CRITICAL_TYPES } = require('../lib/notify');
const { hashIdentifier } = require('../lib/pii');
// Round-26: date helpers hoisted to lib/dateOnly.js so admin-targeted
// templates + cron endpoints can reuse them. Internal-digest stays the
// canonical caller but no longer owns the implementation.
const { getIstDateString, getIstDateLabel, istMidnightUtcFromDateString } = require('../lib/dateOnly');

// The 6 digest-type notifications (complement of CRITICAL_TYPES).
const DIGEST_TYPES = [
  'DPR_REVIEWED',
  'INSPECTION_ACKNOWLEDGED',
  'INSPECTION_CLOSED',
  'LEAVE_DECIDED',
  'TRAINING_IN_PROGRESS',
  'TRAINING_COMPLETED',
];

// Group ordering for the digest body. Critical types stay out; the rest
// follow the order the user encounters them in the in-app bell.
const DIGEST_GROUPS = [
  { type: 'DPR_REVIEWED',              heading: 'Daily Progress Reports' },
  { type: 'INSPECTION_ACKNOWLEDGED',   heading: 'Inspections acknowledged' },
  { type: 'INSPECTION_CLOSED',         heading: 'Inspections closed' },
  { type: 'LEAVE_DECIDED',             heading: 'Leave decisions' },
  { type: 'TRAINING_IN_PROGRESS',      heading: 'Training started' },
  { type: 'TRAINING_COMPLETED',        heading: 'Training completed' },
];

// ─── Time helpers ────────────────────────────────────────────────────────
// Round-26: getIstDateString, getIstDateLabel, istMidnightUtcFromDateString
// moved to lib/dateOnly.js so admin-targeted templates + cron endpoints
// can reuse them. Internal-digest imports them above.

function getPrisma(req) { return req.app.get('prisma'); }

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// ─── Token gate (mirrors /version in index.js) ────────────────────────────
// 404 when unset (so a misconfigured deploy doesn't silently expose the
// endpoint). 403 when the header doesn't match. This is the same pattern
// already in use for the /version probe.
function requireInternalToken(req, res, next) {
  const expected = process.env.INTERNAL_API_TOKEN;
  if (!expected) {
    return res.status(404).json({ error: 'Not found' });
  }
  if (req.headers['x-internal-token'] !== expected) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

// ─── Per-notification link builder ───────────────────────────────────────
// Returns the portal path (without origin) for a notification, or null if
// the FK is missing. Origin comes from the template's portalUrl.
function portalPathFor(notification) {
  switch (notification.type) {
    case 'DPR_REVIEWED':
    case 'DPR_APPROVED':
    case 'DPR_REJECTED':
      return notification.dprId ? `/portal/dpr/${notification.dprId}` : null;
    case 'INSPECTION_ACKNOWLEDGED':
    case 'INSPECTION_CLOSED':
    case 'INSPECTION_REJECTED':
      // Inspection notifications don't carry a recordId in the row — link
      // to the inspection list where the user can find the relevant one.
      return '/portal/inspection';
    case 'LEAVE_DECIDED':
      return notification.leaveRequestId ? `/portal/leave` : '/portal/leave';
    case 'TRAINING_ASSIGNED':
    case 'TRAINING_CANCELLED':
    case 'TRAINING_IN_PROGRESS':
    case 'TRAINING_COMPLETED':
      return notification.trainingEnrollmentId
        ? `/portal/training/${notification.trainingEnrollmentId}`
        : '/portal/training';
    default:
      return '/portal/notifications';
  }
}

// ─── Digest row builder ──────────────────────────────────────────────────
// Turns a flat list of notifications into the grouped shape the digest
// template expects. The handler is responsible for both the grouping and
// the per-row label; the template is a dumb renderer.
function buildGroups(notifications) {
  const byType = new Map();
  for (const n of notifications) {
    if (!byType.has(n.type)) byType.set(n.type, []);
    byType.get(n.type).push(n);
  }
  return DIGEST_GROUPS
    .map((g) => {
      const items = byType.get(g.type) || [];
      return {
        heading: g.heading,
        items: items.map((n) => ({
          // Surface the original message text — admin writes it in their
          // own words ("approved", "rejected because..."), no need to
          // reformat. The template's escapeHtml handles user input.
          label: n.message || g.heading,
        })),
      };
    })
    .filter((g) => g.items.length > 0);
}

// ─── Main handler ────────────────────────────────────────────────────────
router.post('/run', requireInternalToken, asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  if (!prisma) {
    return res.status(500).json({ error: 'Prisma not available' });
  }

  // ?date=YYYY-MM-DD override (used for backfill + the test suite). The
  // scheduledFor key is the IST midnight of that date so the unique
  // constraint is anchored on the same key regardless of who fires the
  // endpoint or when.
  const dateParam = typeof req.query.date === 'string' ? req.query.date : null;
  const now = new Date();
  const targetDateStr = dateParam || getIstDateString(now);
  let scheduledFor;
  try {
    scheduledFor = istMidnightUtcFromDateString(targetDateStr);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  const windowStart = new Date(scheduledFor.getTime() - 24 * 60 * 60 * 1000);

  console.log('[internal-digest] run start', {
    date: targetDateStr,
    windowStart: windowStart.toISOString(),
    windowEnd: scheduledFor.toISOString(),
    emailConfigured: isConfigured(),
  });

  if (!isConfigured()) {
    // No SMTP credentials — refuse to do work that would just create
    // EMPTY digest rows for every employee. The cron will retry tomorrow
    // (or an operator will fix the env var in the meantime).
    return res.status(503).json({
      error: 'Email transport not configured',
      code: 'SMTP_NOT_CONFIGURED',
    });
  }

  // 1. Find every employee with digestEnabled=true who has at least one
  //    eligible notification. We can't just query Notification rows — an
  //    employee might have ZERO notifications in the window, and we want
  //    to record an EMPTY digest for them (audit) rather than skip them.
  //    A LEFT JOIN would do it; the simpler path is two queries:
  //      a) employees with digestEnabled=true
  //      b) notifications in the window
  //    and intersect in memory.
  const employeesWithDigest = await prisma.employee.findMany({
    where: {
      notificationPreference: { digestEnabled: true },
    },
    select: { id: true, name: true, email: true, notificationPreference: true },
  });

  const notificationsInWindow = await prisma.notification.findMany({
    where: {
      employeeId: { in: employeesWithDigest.map((e) => e.id) },
      type: { in: DIGEST_TYPES },
      createdAt: { gte: windowStart, lt: scheduledFor },
    },
    // Only pick up rows that have NOT been digested before (joined via
    // DigestItem). The simplest exclusion is: notificationId NOT IN
    // (SELECT notificationId FROM DigestItem). For the typical small
    // volume (a few dozen rows per day) this is cheap.
    select: {
      id: true,
      employeeId: true,
      type: true,
      message: true,
      dprId: true,
      leaveRequestId: true,
      trainingEnrollmentId: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'asc' },
  });

  // Exclude already-digested notifications (defence against re-fire races
  // that bypass the DigestRun unique constraint, e.g. a different
  // scheduledFor value).
  const alreadyDigested = await prisma.digestItem.findMany({
    where: { notificationId: { in: notificationsInWindow.map((n) => n.id) } },
    select: { notificationId: true },
  });
  const alreadyDigestedIds = new Set(alreadyDigested.map((d) => d.notificationId));
  const freshNotifications = notificationsInWindow.filter((n) => !alreadyDigestedIds.has(n.id));

  // Group by employee.
  const byEmployee = new Map();
  for (const n of freshNotifications) {
    if (!byEmployee.has(n.employeeId)) byEmployee.set(n.employeeId, []);
    byEmployee.get(n.employeeId).push(n);
  }

  // 2. For each eligible employee, try to claim a DigestRun slot. The
  //    unique constraint enforces exactly-once-per-day; a P2002 is a
  //    no-op (already-sent-or-claimed).
  const results = [];
  for (const employee of employeesWithDigest) {
    const items = byEmployee.get(employee.id) || [];
    const isEmpty = items.length === 0;

    // Resolve type-mute: if every notification for this employee is in a
    // muted type, skip (but still record the digest so the audit trail
    // shows we considered them).
    const prefs = employee.notificationPreference || {};
    const typeMutes = (prefs.typeMutes && typeof prefs.typeMutes === 'object') ? prefs.typeMutes : {};
    const unmutedItems = items.filter((n) => typeMutes[n.type] !== true);
    const fullyMuted = unmutedItems.length === 0 && items.length > 0;

    let digestRun;
    let needsCreate = true;
    try {
      digestRun = await prisma.digestRun.create({
        data: {
          employeeId: employee.id,
          scheduledFor,
          status: 'PENDING',
        },
      });
      needsCreate = false;
    } catch (err) {
      // P2002 = unique constraint hit. The previous run for this date
      // exists. If it succeeded (SENT/EMPTY), no-op. If it FAILED, the
      // operator wants us to retry — delete and fall through to retry.
      if (err.code === 'P2002') {
        const existing = await prisma.digestRun.findUnique({
          where: { employeeId_scheduledFor: { employeeId: employee.id, scheduledFor } },
        });
        if (existing && (existing.status === 'SENT' || existing.status === 'EMPTY')) {
          results.push({ employee: hashIdentifier(employee.id), skipped: true, reason: existing.status });
          continue;
        }
        if (existing && existing.status === 'FAILED') {
          // Clean up so we can retry. Items are CASCADE-deleted with the
          // parent (DigestItem.digestRunId onDelete: Cascade).
          await prisma.digestRun.delete({ where: { id: existing.id } });
        } else {
          results.push({ employee: hashIdentifier(employee.id), skipped: true, reason: 'in_flight' });
          continue;
        }
      } else {
        throw err;
      }
    }

    // Re-create the run only if the first attempt hit the FAILED+delete
    // path. The success path has already created the row above and falls
    // through with needsCreate=false.
    if (needsCreate) {
      digestRun = await prisma.digestRun.create({
        data: {
          employeeId: employee.id,
          scheduledFor,
          status: 'PENDING',
        },
      });
    }

    if (isEmpty || fullyMuted) {
      // No email to send; mark EMPTY and move on. We DO still record a
      // row so the audit trail reflects that we considered this employee
      // on this date.
      await prisma.digestRun.update({
        where: { id: digestRun.id },
        data: { status: 'EMPTY', completedAt: new Date() },
      });
      results.push({ employee: hashIdentifier(employee.id), status: 'EMPTY' });
      continue;
    }

    // 3. Render the digest email. We pass groups (heading + label list)
    //    rather than the raw notifications — the template is dumb.
    const groups = buildGroups(unmutedItems);
    const rendered = renderDigestTemplate({
      context: {
        employeeName: employee.name || 'there',
        dateLabel: getIstDateLabel(scheduledFor),
        groups,
      },
    });

    // 4. Send. sendEmail never throws; failure paths return { ok: false, ... }.
    const result = await sendEmail({
      to: employee.email,
      subject: rendered.subject,
      html: rendered.html,
    });

    // 5. Write the audit row. We pass employeeId (required) but no
    //    notificationId (the digest is a rollup, not a single row).
    const emailLog = await prisma.emailLog.create({
      data: {
        employeeId: employee.id,
        notificationId: null,
        recipientEmail: employee.email || '',
        subject: rendered.subject,
        channel: 'DIGEST',
        status: result.ok ? 'SENT' : 'FAILED',
        providerMessageId: result.messageId || null,
        errorMessage: result.ok ? null : (result.error || `HTTP_${result.statusCode}`),
      },
    });

    // 6. Update the DigestRun with the outcome and link the email log.
    if (result.ok) {
      await prisma.digestRun.update({
        where: { id: digestRun.id },
        data: {
          status: 'SENT',
          emailLogId: emailLog.id,
          completedAt: new Date(),
        },
      });
      // 7. Link the individual notifications to this digest run so they
      //    are not re-included in a future digest (defence-in-depth; the
      //    unique constraint on (employeeId, scheduledFor) is the primary
      //    guard).
      await prisma.digestItem.createMany({
        data: unmutedItems.map((n) => ({
          digestRunId: digestRun.id,
          employeeId: employee.id,
          notificationId: n.id,
        })),
      });
      results.push({ employee: hashIdentifier(employee.id), status: 'SENT', count: unmutedItems.length });
    } else {
      await prisma.digestRun.update({
        where: { id: digestRun.id },
        data: {
          status: 'FAILED',
          errorMessage: result.error || 'UNKNOWN',
          completedAt: new Date(),
        },
      });
      results.push({ employee: hashIdentifier(employee.id), status: 'FAILED', error: result.error });
    }
  }

  const sent = results.filter((r) => r.status === 'SENT').length;
  const empty = results.filter((r) => r.status === 'EMPTY').length;
  const failed = results.filter((r) => r.status === 'FAILED').length;
  const skipped = results.filter((r) => r.skipped).length;

  console.log('[internal-digest] run done', {
    date: targetDateStr,
    sent, empty, failed, skipped, totalEmployees: employeesWithDigest.length,
  });

  res.json({
    date: targetDateStr,
    scheduledFor: scheduledFor.toISOString(),
    sent, empty, failed, skipped,
    totalEmployees: employeesWithDigest.length,
    results,
  });
}));

module.exports = router;
