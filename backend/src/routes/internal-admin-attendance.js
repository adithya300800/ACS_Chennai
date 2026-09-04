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
//   This endpoint does NOT pin idempotency at the application layer — the
//   digests are read-only and idempotent by construction (the data didn't
//   change between two fires on the same date). If a double-fire ever
//   becomes a concern, add a DigestRun-style unique key on (date, employee).
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

  for (const admin of admins) {
    try {
      // Per-admin prefs gate. Admins who flipped their master switch or
      // explicitly muted this type stay silent; we still audit-log.
      const prefs = await prisma.notificationPreference.findUnique({
        where: { employeeId: admin.id },
      }).catch(() => null);

      if (prefs && prefs.emailEnabled === false) {
        await prisma.emailLog.create({
          data: {
            employeeId: admin.id,
            notificationId: null,
            recipientEmail: admin.email || '',
            subject: rendered.subject,
            channel: 'ADMIN_DIGEST',
            status: 'SKIPPED_OPT_OUT',
          },
        });
        skipped += 1;
        continue;
      }
      const typeMutes = (prefs && prefs.typeMutes && typeof prefs.typeMutes === 'object') ? prefs.typeMutes : {};
      if (typeMutes.ADMIN_ATTENDANCE_DAILY === true) {
        await prisma.emailLog.create({
          data: {
            employeeId: admin.id,
            notificationId: null,
            recipientEmail: admin.email || '',
            subject: rendered.subject,
            channel: 'ADMIN_DIGEST',
            status: 'SKIPPED_TYPE_MUTED',
          },
        });
        skipped += 1;
        continue;
      }

      if (!admin.email) {
        await prisma.emailLog.create({
          data: {
            employeeId: admin.id,
            notificationId: null,
            recipientEmail: '',
            subject: rendered.subject,
            channel: 'ADMIN_DIGEST',
            status: 'SKIPPED_NO_ADDRESS',
          },
        });
        skipped += 1;
        continue;
      }

      const result = await sendEmail({ to: admin.email, subject: rendered.subject, html: rendered.html });
      await prisma.emailLog.create({
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
      if (result.ok) sent += 1; else failed += 1;
    } catch (err) {
      console.error('[internal-admin-attendance] per-admin send failed', {
        recipient: hashIdentifier(admin.id),
        message: err?.message?.split('\n')[0],
      });
      failed += 1;
    }
  }

  console.log('[internal-admin-attendance] digest done', {
    date: targetDateStr,
    admins: admins.length,
    sent, skipped, failed,
    sections: { present: present.length, onLeave: onLeave.length, absent: absent.length },
  });

  res.json({
    date: targetDateStr,
    adminsFound: admins.length,
    sent,
    skipped,
    failed,
    sections: {
      present: present.length,
      onLeave: onLeave.length,
      absent: absent.length,
    },
  });
}));

module.exports = router;
