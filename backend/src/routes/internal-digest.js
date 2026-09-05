// Round-25 (M2): Daily digest cron handler.
//
// Endpoint:
//   POST /api/internal/digest/run
//     Header: X-Internal-Token: <INTERNAL_API_TOKEN>
//     Optional: ?date=YYYY-MM-DD  (for backfill / dry-runs; default = today IST)
//
// Architecture:
//   The digest cron fires this endpoint every hour (see
//   .github/workflows/digest.yml). For each employee whose
//   `digestHourLocal` matches the current IST hour AND who has at least
//   one unread digest-type notification in the last 24h, we render a
//   grouped digest email and send via Zoho SMTP. A `DigestRun` row pins
//   idempotency so a re-fire within the same business date is a no-op.
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
//
// S3-3 (digestHourLocal decision): the per-user `digestHourLocal`
// preference is now HONOURED rather than removed. The cron schedule
// (digest.yml) was changed from "30 2 * * *" (daily 08:00 IST) to "0 *
// * * *" (every hour on the hour). Each hourly fire only sends to
// employees whose `digestHourLocal` matches the current IST hour; users
// whose hour hasn't arrived yet are silently skipped (no DigestRun row
// written — their hour-match cron will pick them up). The
// DigestRun.@@unique([employeeId, scheduledFor]) guarantee still holds
// because every employee gets exactly one fire per day (the matching
// one). S3-3 makes the existing 8 AM default work the same as before
// for users who never touched the setting; users who set their own
// hour get a digest at that hour instead of 8 AM.

'use strict';

const express = require('express');
const router = express.Router();
const { sendEmail, isConfigured } = require('../lib/email');
const { renderDigestTemplate } = require('../templates/email');
const { CRITICAL_TYPES, shouldSkipSend } = require('../lib/notify');
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
//
// S3-3: digestHourLocal matching. getCurrentIstHour() returns the wall-
// clock hour in Asia/Kolkata so the digest handler can pick which
// employees to send to on each hourly cron fire. `Intl.DateTimeFormat`
// is the only cross-runtime-safe way to derive a TZ-local hour without
// relying on `process.env.TZ` (which is set at process start and not
// always honoured by container runners).
let _currentIstHourOverride = null;
function getCurrentIstHour() {
  if (_currentIstHourOverride !== null && _currentIstHourOverride !== undefined) {
    return _currentIstHourOverride;
  }
  const hourStr = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    hour12: false,
  }).format(new Date());
  return Number(hourStr);
}
// Test-only hooks. Production never touches these — the cron fires
// every hour and the wall-clock hour is the source of truth.
function _setCurrentIstHourForTest(hour) { _currentIstHourOverride = hour; }
function _resetCurrentIstHourForTest() { _currentIstHourOverride = null; }

function getPrisma(req) { return req.app.get('prisma'); }

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// ─── Stale-PENDING recovery (LPR-010) ─────────────────────────────────────
//
// A DigestRun row is created with status='PENDING' at the top of the /run
// loop, then mutated to SENT / EMPTY / FAILED as the work completes. If the
// process dies between create and update — Render free-plan cold-start
// timeout, OOM, uncaught exception — the row stays PENDING forever. Every
// subsequent /run for that (employee, scheduledFor) sees the PENDING row,
// falls into the "in_flight" branch below, and skips the employee. The
// digest silently never re-attempts.
//
// recoverStalePendingRuns() finds any PENDING row older than
// STALE_PENDING_MIN_AGE_MS (= 1 hour) and flips it to FAILED with an
// errorMessage that names the recovery path. The next /run for that
// (employee, scheduledFor) will then see status='FAILED', delete the row
// (per the existing FAILED-cleanup branch in /run), and retry.
//
// Idempotent — safe to call on every /run. Uses a single UPDATE ... WHERE
// to avoid a TOCTOU between the findMany and the per-row update.
const STALE_PENDING_MIN_AGE_MS = 60 * 60 * 1000; // 1 hour

async function recoverStalePendingRuns(prisma) {
  const cutoff = new Date(Date.now() - STALE_PENDING_MIN_AGE_MS);
  try {
    const stale = await prisma.digestRun.findMany({
      where: {
        status: 'PENDING',
        createdAt: { lt: cutoff },
      },
      select: { id: true, employeeId: true, scheduledFor: true, createdAt: true },
      take: 500, // bounded so a backlog can't lock the request indefinitely
    });
    if (stale.length === 0) return { recovered: 0 };

    const ids = stale.map((r) => r.id);
    const result = await prisma.digestRun.updateMany({
      where: {
        id: { in: ids },
        status: 'PENDING', // defence: re-check status atomically
      },
      data: {
        status: 'FAILED',
        errorMessage: 'auto-recovered from stale PENDING (process died mid-run)',
      },
    });
    console.log('[internal-digest] recovered stale PENDING runs', {
      recovered: result.count,
      cutoff: cutoff.toISOString(),
    });
    return { recovered: result.count };
  } catch (err) {
    // Recovery is best-effort — never fail the /run request because of it.
    console.error('[internal-digest] stale-PENDING recovery error', {
      message: err?.message?.split('\n')[0],
    });
    return { recovered: 0, error: true };
  }
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

  // LPR-010: clear any PENDING runs that outlived their owning process
  // (Render cold-start timeout, OOM, uncaught exception). Without this the
  // "in_flight" branch below short-circuits every subsequent /run for that
  // (employee, scheduledFor) and the digest silently never re-attempts.
  const recovery = await recoverStalePendingRuns(prisma);

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
  //
  //    S3-1: the original filter `notificationPreference: { digestEnabled: true }`
  //    excluded any employee who never opened the Preferences page and
  //    therefore has no `notification_preference` row — Prisma's to-one
  //    relation filter only matches rows where the relation exists AND
  //    the nested predicate holds. That contradicts the documented
  //    contract "null row = permissive defaults (all on)" (see
  //    notifications.js). OR-ing in `notificationPreference: { is: null }`
  //    restores the documented behaviour: a fresh employee gets a digest
  //    by default and has to actively opt out.
  const employeesWithDigest = await prisma.employee.findMany({
    where: {
      OR: [
        { notificationPreference: { is: null } },
        { notificationPreference: { digestEnabled: true } },
      ],
    },
    select: { id: true, name: true, email: true, notificationPreference: true },
  });

  // S3-4: already-read notifications are excluded from digests. The
  // schema's `is_read` column (default false) flips to true the moment
  // the user marks the item as read in the bell UI; bundling them again
  // the next morning would re-list items the user already actioned.
  // The file's header comment claimed "unread-only" but the predicate
  // was missing — fix lands here.
  const notificationsInWindow = await prisma.notification.findMany({
    where: {
      employeeId: { in: employeesWithDigest.map((e) => e.id) },
      type: { in: DIGEST_TYPES },
      isRead: false,
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
    // shows we considered them). Defaults are permissive (null row →
    // fully enabled) so S3-1's query fix and the per-row fallback here
    // both honour the documented contract.
    const prefs = employee.notificationPreference || {
      emailEnabled: true,
      digestEnabled: true,
      typeMutes: {},
      digestHourLocal: 8,
    };
    const typeMutes = (prefs.typeMutes && typeof prefs.typeMutes === 'object') ? prefs.typeMutes : {};
    const unmutedItems = items.filter((n) => typeMutes[n.type] !== true);
    const fullyMuted = unmutedItems.length === 0 && items.length > 0;

    // S3-3: honour the per-user digestHourLocal preference. The cron
    // fires every hour; only employees whose preferred hour matches the
    // current IST hour get a digest on this fire. A mismatch is a silent
    // skip (no DigestRun written) so the matching-hour cron can pick
    // them up without racing a stale PENDING row.
    const currentHour = getCurrentIstHour();
    const userHour = Number.isInteger(prefs.digestHourLocal) ? prefs.digestHourLocal : 8;
    if (currentHour !== userHour) {
      results.push({
        employee: hashIdentifier(employee.id),
        skipped: true,
        reason: 'hour_mismatch',
      });
      continue;
    }

    // S3-2: honour the master `emailEnabled` kill switch. The digest
    // path previously read `digestEnabled` + `typeMutes` only and
    // ignored `emailEnabled` entirely — so a user who turned OFF all
    // email still got daily digests. Route the gate through the
    // existing shouldSkipSend helper so the null-row permissive default
    // is uniform across immediate + admin + digest paths.
    //
    // We pass a sentinel type '__digest_gate__' so the per-type mute
    // check inside shouldSkipSend is a no-op for this call (users can
    // only mute real notification types — see ALLOWED_NOTIFICATION_TYPES
    // in notifications.js). The per-item typeMutes filter on
    // `unmutedItems` above is the right semantic for digests (partial
    // mute → send the un-muted items), so we deliberately don't let
    // shouldSkipSend's per-type short-circuit override it.
    const emailVerdict = shouldSkipSend(prefs, '__digest_gate__', 'DIGEST');
    const emailDisabled = emailVerdict.skip && emailVerdict.status === 'SKIPPED_OPT_OUT';

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

    if (isEmpty || fullyMuted || emailDisabled) {
      // No email to send; mark EMPTY and move on. We DO still record a
      // row so the audit trail reflects that we considered this employee
      // on this date. For emailDisabled (S3-2) we stash the reason in
      // errorMessage so an operator can tell apart "user opted out via
      // emailEnabled=false" from "nothing happened in the last 24h".
      await prisma.digestRun.update({
        where: { id: digestRun.id },
        data: {
          status: 'EMPTY',
          completedAt: new Date(),
          ...(emailDisabled ? { errorMessage: emailVerdict.errorMessage || 'email disabled' } : {}),
        },
      });
      results.push({
        employee: hashIdentifier(employee.id),
        status: 'EMPTY',
        ...(emailDisabled ? { reason: emailVerdict.errorMessage || 'email disabled' } : {}),
      });
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
    sent, empty, failed, skipped,
    totalEmployees: employeesWithDigest.length,
    recoveredFromStalePending: recovery.recovered || 0,
  });

  res.json({
    date: targetDateStr,
    scheduledFor: scheduledFor.toISOString(),
    sent, empty, failed, skipped,
    totalEmployees: employeesWithDigest.length,
    recoveredFromStalePending: recovery.recovered || 0,
    results,
  });
}));

module.exports = router;
// S3-3: test hooks for the current-IST-hour override. Production code
// never touches these — the wall-clock hour is the source of truth.
module.exports._setCurrentIstHourForTest = _setCurrentIstHourForTest;
module.exports._resetCurrentIstHourForTest = _resetCurrentIstHourForTest;
module.exports.getCurrentIstHour = getCurrentIstHour;
