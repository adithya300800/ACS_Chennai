// Round-26: Admin-targeted daily attendance digest cron handler.
//
// Endpoint:
//   POST /api/internal/attendance/digest/run
//     Header: X-Internal-Token: <INTERNAL_API_TOKEN>
//     Optional: ?date=YYYY-MM-DD  (for backfill / dry-runs; default = today IST)
//
// Architecture:
//   The Render Cron Job fires this endpoint at 13:30 UTC (= 19:00 IST) every
//   day. We partition every active employee into one of three buckets for
//   the target date:
//
//     - present[]   — has at least one Attendance row with status='Present'
//                     (the only status currently written; see attendance.js)
//     - onLeave[]   — has an APPROVED LeaveRequest overlapping the date
//     - absent[]    — neither: no Present row AND no APPROVED leave
//
//   Admins are EXCLUDED from the grid (they don't mark attendance). Each
//   admin then gets one email rendered from renderAdminAttendanceDigest.
//
// Idempotency:
//   Pinned at the application layer by the AdminDigestRun table
//   (backend/prisma/migrations/<ts>_s3_11_admin_digest_run). Per-admin
//   lifecycle:
//     1. Atomic claim: prisma.adminDigestRun.create({ adminId, scheduledFor,
//        status: 'PENDING' }) — Prisma raises P2002 if a row already exists
//        for this (admin, date). P2002 → increment idempotentSkips + skip
//        the entire per-admin block (read-only idempotency; no EmailLog
//        row, no Resend call).
//     2. Terminal update: after the EmailLog row is written, update the
//        AdminDigestRun with status = SENT / SKIPPED_* / FAILED and link
//        emailLogId. If the EmailLog.create throws, the per-admin block's
//        outer catch stamps status = 'FAILED' + the error message.
//
//   Double-fire scenarios:
//     - workflow_dispatch firing the same job twice within seconds
//       (scheduled + manual). The second fire finds every admin already
//       claimed → idempotentSkips == adminsFound, sent == 0, no Resend
//       traffic. Operators alert on idempotentSkips > 0 across two fires
//       that are not supposed to overlap (e.g. a daily cron fire AND a
//       manual backfill fire on the same calendar day).
//     - Two concurrent in-flight fires (TOCTOU). The @@unique([adminId,
//       scheduledFor]) constraint race-safes the claim; whichever
//       transaction loses the INSERT race gets P2002 and short-circuits.
//
//   Force-replay: deliberately NOT supported in this PR. A future
//   `?force=true` opt-in is a separate design decision (the simplest
//   implementation is `deleteMany({ adminId, scheduledFor })` before the
//   claim, but that destroys audit history). Out of scope here.
//
// Section counts:
//   present + onLeave + absent = (active employees − admins). Each section
//   may be empty; the template renders the heading either way (an empty
//   "Absent (0)" section lets the admin see that "no one is missing"
//   instead of inferring absence from missing sections).

'use strict';

const express = require('express');
const router = express.Router();
const { sendEmail, isConfigured } = require('../lib/email');
const {
  renderAdminAttendanceDigest,
  wrapHtml,
  ctaButton,
  escapeHtml,
  PORTAL_URL,
} = require('../templates/email');
const { findActiveAdmins } = require('../lib/adminRecipients');
const { hashIdentifier } = require('../lib/pii');
const { getIstDateString, getIstDateLabel, istMidnightUtcFromDateString } = require('../lib/dateOnly');

function getPrisma(req) { return req.app.get('prisma'); }

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// Mirror internal-digest.js:105 — 404 when unset, 403 when mismatched.
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

// Partition logic. Pure function — given the raw prisma rows, return three
// arrays. The route handler queries prisma; this function just classifies.
function partitionEmployees({ employees, presentByEmployeeId, onLeaveEmployeeIds }) {
  const present = [];
  const onLeave = [];
  const absent = [];

  for (const emp of employees) {
    if (onLeaveEmployeeIds.has(emp.id)) {
      onLeave.push({ name: emp.name || 'Unnamed' });
      continue;
    }
    const att = presentByEmployeeId.get(emp.id);
    if (att && att.checkInLabel) {
      present.push({ name: emp.name || 'Unnamed', checkInLabel: att.checkInLabel });
      continue;
    }
    absent.push({ name: emp.name || 'Unnamed' });
  }

  return { present, onLeave, absent };
}

router.post('/run', requireInternalToken, asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  if (!prisma) {
    return res.status(500).json({ error: 'Prisma not available' });
  }

  const dateParam = typeof req.query.date === 'string' ? req.query.date : null;
  const now = new Date();
  const targetDateStr = dateParam || getIstDateString(now);
  let dateIstUtc;
  try {
    dateIstUtc = istMidnightUtcFromDateString(targetDateStr);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  console.log('[internal-admin-attendance] digest start', {
    date: targetDateStr,
    emailConfigured: isConfigured(),
  });

  if (!isConfigured()) {
    return res.status(503).json({
      error: 'Email transport not configured',
      code: 'SMTP_NOT_CONFIGURED',
    });
  }

  // 1. All non-admin employees — the grid is for people who mark attendance.
  //    Employee schema has NO `isActive` column, so we use `isAdmin: false`
  //    as the working set. (Admins don't punch in; they appear as "excluded"
  //    in the response so an operator scanning logs can see we deliberately
  //    skipped them rather than forgetting.)
  const employees = await prisma.employee.findMany({
    where: { isAdmin: false },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });

  // 2. Present rows: one Attendance row per (employee, date) max via the
  //    @@unique([employeeId, date]) constraint. We ask for the first session
  //    check-in via the sessions relation ordered ASC so the earliest in-time
  //    of the day shows up.
  const attendanceRows = await prisma.attendance.findMany({
    where: { date: dateIstUtc, status: 'Present' },
    select: {
      employeeId: true,
      sessions: {
        orderBy: { checkIn: 'asc' },
        take: 1,
        select: { checkIn: true },
      },
    },
  });

  const presentByEmployeeId = new Map();
  for (const row of attendanceRows) {
    if (!row.sessions || row.sessions.length === 0) continue;
    const checkIn = row.sessions[0].checkIn;
    if (!(checkIn instanceof Date)) continue;
    // Display label in IST — the on-site reality, not the server-local
    // wall-clock. The HR office reads 19:00 IST emails at 19:00 IST.
    const label = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(checkIn);
    presentByEmployeeId.set(row.employeeId, { checkInLabel: label });
  }

  // 3. Approved leave overlapping [dateIST, dateIST+24h]. The LeaveRequest
  //    schema stores startDate/endDate as `@db.Date` UTC midnight per DR-023
  //    + DR-031, so the half-open `gte: dateIST + lt: dateIST+24h` predicate
  //    is the correct "covers this calendar day" check.
  const dayEnd = new Date(dateIstUtc.getTime() + 24 * 60 * 60 * 1000);
  const approvedLeaves = await prisma.leaveRequest.findMany({
    where: {
      status: 'APPROVED',
      startDate: { lt: dayEnd },
      endDate: { gte: dateIstUtc },
    },
    select: { employeeId: true },
  });
  const onLeaveEmployeeIds = new Set(approvedLeaves.map((l) => l.employeeId));

  // 4. Partition. `present` wins over `onLeave` if both apply (an employee
  //    who marked Present on a day they had approved leave is treated as
  //    Present — the typical "I'm back from leave, came in for the morning"
  //    pattern).
  const { present, onLeave, absent } = partitionEmployees({
    employees,
    presentByEmployeeId,
    onLeaveEmployeeIds,
  });

  const admins = await findActiveAdmins(prisma);
  if (admins.length === 0) {
    console.warn('[internal-admin-attendance] no active admins to email', {
      date: targetDateStr,
    });
    return res.json({
      date: targetDateStr,
      adminsFound: 0,
      sent: 0,
      skipped: 0,
      failed: 0,
      sections: {
        present: present.length,
        onLeave: onLeave.length,
        absent: absent.length,
      },
    });
  }

  // 5. Render once — same body for every admin (we're not personalising
  //    name/signature for the digest; the chrome footer addresses "Admin").
  //    The chrome helpers (wrapHtml, ctaButton, escapeHtml) and portalUrl
  //    come from templates/email so a future style change is a one-line
  //    edit (matches the existing renderTemplate contract — see
  //    src/templates/email/index.js:85).
  const rendered = renderAdminAttendanceDigest({
    context: {
      istDateLabel: getIstDateLabel(dateIstUtc),
      present,
      onLeave,
      absent,
    },
    wrapHtml,
    ctaButton,
    escapeHtml,
    portalUrl: PORTAL_URL,
  });

  let sent = 0;
  let skipped = 0;
  let failed = 0;
  let idempotentSkips = 0;

  for (const admin of admins) {
    try {
      // [REPORT-S3-11] Atomic claim. Inserting (adminId, scheduledFor)
      // raises P2002 if a prior fire already claimed this admin for this
      // date — we short-circuit the entire per-admin block (no email,
      // no EmailLog row). The @@unique constraint races-safe against any
      // concurrent in-flight fire on the same date.
      try {
        await prisma.adminDigestRun.create({
          data: {
            adminId: admin.id,
            scheduledFor: dateIstUtc,
            status: 'PENDING',
          },
        });
      } catch (claimErr) {
        if (claimErr && claimErr.code === 'P2002') {
          idempotentSkips += 1;
          continue;
        }
        throw claimErr;
      }

      // Per-admin prefs gate. Admins who flipped their master switch or
      // explicitly muted this type stay silent; we still audit-log.
      const prefs = await prisma.notificationPreference.findUnique({
        where: { employeeId: admin.id },
      }).catch(() => null);

      let terminalStatus;
      let emailLogId = null;
      let errorMessage = null;

      if (prefs && prefs.emailEnabled === false) {
        const logRow = await prisma.emailLog.create({
          data: {
            employeeId: admin.id,
            notificationId: null,
            recipientEmail: admin.email || '',
            subject: rendered.subject,
            channel: 'ADMIN_DIGEST',
            status: 'SKIPPED_OPT_OUT',
          },
        });
        emailLogId = logRow.id;
        terminalStatus = 'SKIPPED_OPT_OUT';
        skipped += 1;
      } else {
        const typeMutes = (prefs && prefs.typeMutes && typeof prefs.typeMutes === 'object') ? prefs.typeMutes : {};
        if (typeMutes.ADMIN_ATTENDANCE_DAILY === true) {
          const logRow = await prisma.emailLog.create({
            data: {
              employeeId: admin.id,
              notificationId: null,
              recipientEmail: admin.email || '',
              subject: rendered.subject,
              channel: 'ADMIN_DIGEST',
              status: 'SKIPPED_TYPE_MUTED',
            },
          });
          emailLogId = logRow.id;
          terminalStatus = 'SKIPPED_TYPE_MUTED';
          skipped += 1;
        } else if (!admin.email) {
          const logRow = await prisma.emailLog.create({
            data: {
              employeeId: admin.id,
              notificationId: null,
              recipientEmail: '',
              subject: rendered.subject,
              channel: 'ADMIN_DIGEST',
              status: 'SKIPPED_NO_ADDRESS',
            },
          });
          emailLogId = logRow.id;
          terminalStatus = 'SKIPPED_NO_ADDRESS';
          skipped += 1;
        } else {
          const result = await sendEmail({ to: admin.email, subject: rendered.subject, html: rendered.html });
          const logRow = await prisma.emailLog.create({
            data: {
              employeeId: admin.id,
              notificationId: null,
              recipientEmail: admin.email,
              subject: rendered.subject,
              channel: 'ADMIN_DIGEST',
              status: result.ok ? 'SENT' : 'FAILED',
              providerMessageId: result.messageId || null,
              errorMessage: result.ok ? null : (result.error || `HTTP_${result.statusCode}`),
            },
          });
          emailLogId = logRow.id;
          if (result.ok) {
            terminalStatus = 'SENT';
            sent += 1;
          } else {
            terminalStatus = 'FAILED';
            errorMessage = result.error || `HTTP_${result.statusCode}`;
            failed += 1;
          }
        }
      }

      // Terminal update — links the resulting EmailLog row and stamps the
      // final status. Wrapped in its own try/catch so a failure here does
      // not double-count into the outer `failed += 1` (the EmailLog was
      // already written and is the source of truth for the dispatch).
      try {
        await prisma.adminDigestRun.update({
          where: {
            adminId_scheduledFor: {
              adminId: admin.id,
              scheduledFor: dateIstUtc,
            },
          },
          data: {
            status: terminalStatus,
            emailLogId,
            errorMessage,
          },
        });
      } catch (updateErr) {
        console.error('[internal-admin-attendance] AdminDigestRun terminal update failed', {
          recipient: hashIdentifier(admin.id),
          message: updateErr?.message?.split('\n')[0],
        });
      }
    } catch (err) {
      console.error('[internal-admin-attendance] per-admin send failed', {
        recipient: hashIdentifier(admin.id),
        message: err?.message?.split('\n')[0],
      });
      // Stamp FAILED on the AdminDigestRun so the bookkeeping reflects
      // the dispatch attempt even when the EmailLog write blew up. The
      // terminal update above only runs on the happy path; we attempt a
      // best-effort update here too.
      try {
        await prisma.adminDigestRun.update({
          where: {
            adminId_scheduledFor: {
              adminId: admin.id,
              scheduledFor: dateIstUtc,
            },
          },
          data: {
            status: 'FAILED',
            errorMessage: err?.message?.split('\n')[0] || 'unknown error',
          },
        });
      } catch (_) {
        // Swallow — the outer failure is already logged above.
      }
      failed += 1;
    }
  }

  console.log('[internal-admin-attendance] digest done', {
    date: targetDateStr,
    admins: admins.length,
    sent, skipped, failed, idempotentSkips,
    sections: { present: present.length, onLeave: onLeave.length, absent: absent.length },
  });

  res.json({
    date: targetDateStr,
    adminsFound: admins.length,
    sent,
    skipped,
    failed,
    // [REPORT-S3-11] Count of admins already claimed for this date by a
    // prior fire. > 0 indicates a double-fire (workflow_dispatch re-
    // firing the cron, two parallel cron workers, manual backfill
    // overlap). Operators alert on non-zero values that don't have a
    // known reason.
    idempotentSkips,
    sections: {
      present: present.length,
      onLeave: onLeave.length,
      absent: absent.length,
    },
  });
}));

module.exports = router;
