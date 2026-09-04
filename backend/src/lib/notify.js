// Round-25: Email dispatch helper for the in-app notification system.
//
// Architecture (see plan):
//
//   prisma.notification.create (existing 13 call sites — UNTOUCHED for tx)
//          │
//          └──► fanOutEmail(notification)             ← this module
//                    │
//                    ├── CRITICAL_TYPES.has(type)
//                    │       └─► sendImmediate()       (5 critical types)
//                    │               ├─► render template → HTML
//                    │               ├─► Resend HTTP send
//                    │               └─► EmailLog row (SENT / FAILED / SKIPPED_*)
//                    │
//                    └── default
//                            └─► enqueueForDigest()   (6 informational types)
//                                    └─► (no email today; digest cron picks up
//                                         in M2 via DigestItem join)
//
// All paths are best-effort and never throw to the caller — a notification
// email failure must never downgrade a successful API response. The contract
// matches the existing `try { prisma.notification.create } catch { console.error }`
// pattern in every call site, just one layer up.

const { hashIdentifier } = require('./pii');
const { sendEmail, isConfigured } = require('./email');
const { renderTemplate } = require('../templates/email');
const { findActiveAdmins } = require('./adminRecipients');

// Single source of truth for which notification types fire immediately vs.
// wait for the daily digest. Changing this set is a one-line code edit;
// the test suite pins the membership so a refactor doesn't silently flip
// a type's channel.
const CRITICAL_TYPES = new Set([
  'TRAINING_ASSIGNED',
  'TRAINING_CANCELLED',
  'DPR_APPROVED',
  'DPR_REJECTED',
  'INSPECTION_REJECTED',
]);

function isCritical(type) {
  return CRITICAL_TYPES.has(type);
}

/**
 * Best-effort dispatch hook. Call after `prisma.notification.create` at every
 * call site. Notification row is already persisted by the caller; this
 * function decides whether to fire an immediate email or queue the
 * notification for the digest bucket, and writes the audit row.
 *
 * The `notification` parameter is the raw Prisma row (or a slim object with
 * the columns we need: id, employeeId, type, message, + optional FK ids).
 * For email rendering we read the template by `notification.type` and pass
 * the whole row + any context fields.
 *
 * The `prisma` parameter is REQUIRED because fan-out can happen AFTER the
 * request response is sent (we never want to block the API), and the req
 * object may already be torn down by then. Pass the prisma instance
 * explicitly to keep this helper independent of Express lifecycle.
 *
 * Extra context (e.g. projectName for DPR notifications, courseTitle for
 * training) is supplied via `context` — see lib/templates/email/types.js
 * for which keys each template reads.
 */
async function fanOutEmail(notification, prisma, context = {}) {
  if (!notification || !notification.type || !notification.employeeId) {
    return; // Defensive: a malformed row is not our problem.
  }
  if (!prisma) {
    console.warn('[notify] fanOutEmail called without prisma; skipping');
    return;
  }
  try {
    if (isCritical(notification.type)) {
      await sendImmediate(notification, prisma, context);
    } else {
      await enqueueForDigest(notification, prisma, context);
    }
  } catch (err) {
    // Defence in depth — sendImmediate / enqueueForDigest already swallow
    // their own errors, but if anything escapes we MUST NOT propagate.
    console.error('[notify] dispatch failed', {
      notificationId: notification.id,
      type: notification.type,
      message: err?.message?.split('\n')[0],
    });
  }
}

/**
 * Critical-type path: render → send → audit.
 *
 * Honours three opt-out signals before attempting to send:
 *   1. master emailEnabled = false      → SKIPPED_OPT_OUT
 *   2. typeMutes[type] = true           → SKIPPED_TYPE_MUTED
 *   3. employee has no email address    → SKIPPED_NO_ADDRESS
 */
async function sendImmediate(notification, prisma, context) {
  if (!prisma) return;

  let prefs;
  try {
    prefs = await prisma.notificationPreference.findUnique({
      where: { employeeId: notification.employeeId },
    });
  } catch (err) {
    console.error('[notify/immediate] preference lookup failed', {
      notificationId: notification.id,
      message: err?.message?.split('\n')[0],
    });
    return;
  }

  // Master kill switch (default = on, so a missing prefs row is treated as enabled).
  if (prefs && prefs.emailEnabled === false) {
    await writeEmailLog({
      prisma,
      notification,
      channel: 'IMMEDIATE',
      status: 'SKIPPED_OPT_OUT',
    });
    return;
  }

  // Per-type mute (default = not muted).
  const typeMutes = (prefs && prefs.typeMutes && typeof prefs.typeMutes === 'object') ? prefs.typeMutes : {};
  if (typeMutes[notification.type] === true) {
    await writeEmailLog({
      prisma,
      notification,
      channel: 'IMMEDIATE',
      status: 'SKIPPED_TYPE_MUTED',
    });
    return;
  }

  // Resolve the recipient email. We need it for both the send + the audit row.
  let recipientEmail;
  try {
    const employee = await prisma.employee.findUnique({
      where: { id: notification.employeeId },
      select: { email: true },
    });
    recipientEmail = employee?.email || null;
  } catch (err) {
    console.error('[notify/immediate] employee lookup failed', {
      notificationId: notification.id,
      message: err?.message?.split('\n')[0],
    });
    return;
  }

  if (!recipientEmail) {
    await writeEmailLog({
      prisma,
      notification,
      channel: 'IMMEDIATE',
      status: 'SKIPPED_NO_ADDRESS',
      recipientEmail: '',
    });
    return;
  }

  if (!isConfigured()) {
    await writeEmailLog({
      prisma,
      notification,
      channel: 'IMMEDIATE',
      status: 'SKIPPED_OPT_OUT', // "we deliberately didn't try"
      recipientEmail,
      errorMessage: 'RESEND_API_KEY not set',
    });
    return;
  }

  // Render. The template may throw on bad input — we catch and log.
  let subject;
  let html;
  try {
    const rendered = renderTemplate(notification.type, { notification, context, recipientEmail });
    subject = rendered.subject;
    html = rendered.html;
  } catch (err) {
    console.error('[notify/immediate] template render failed', {
      notificationId: notification.id,
      type: notification.type,
      message: err?.message?.split('\n')[0],
    });
    await writeEmailLog({
      prisma,
      notification,
      channel: 'IMMEDIATE',
      status: 'FAILED',
      recipientEmail,
      errorMessage: `template: ${err?.message?.split('\n')[0] || 'unknown'}`,
    });
    return;
  }

  const result = await sendEmail({ to: recipientEmail, subject, html });
  await writeEmailLog({
    prisma,
    notification,
    channel: 'IMMEDIATE',
    status: result.ok ? 'SENT' : 'FAILED',
    recipientEmail,
    subject,
    providerMessageId: result.messageId || null,
    errorMessage: result.ok ? null : (result.error || `HTTP_${result.statusCode}`),
  });
}

/**
 * Non-critical path: mark the notification as eligible for the daily digest.
 *
 * M1 leaves the actual digest send for the cron job (M2). Here we record the
 * candidate in the EmailLog so we have an audit trail of what was queued
 * (status = PENDING_DIGEST, so an operator scanning email_log can see the
 * intent even before the digest cron ships).
 */
async function enqueueForDigest(notification, prisma, context) {
  if (!prisma) return;

  let prefs;
  try {
    prefs = await prisma.notificationPreference.findUnique({
      where: { employeeId: notification.employeeId },
    });
  } catch (err) {
    console.error('[notify/digest] preference lookup failed', {
      notificationId: notification.id,
      message: err?.message?.split('\n')[0],
    });
    return;
  }

  // Master switches for the digest path.
  if (prefs && prefs.emailEnabled === false) {
    await writeEmailLog({
      prisma,
      notification,
      channel: 'DIGEST',
      status: 'SKIPPED_OPT_OUT',
    });
    return;
  }
  if (prefs && prefs.digestEnabled === false) {
    await writeEmailLog({
      prisma,
      notification,
      channel: 'DIGEST',
      status: 'SKIPPED_OPT_OUT',
      errorMessage: 'digest disabled',
    });
    return;
  }

  const typeMutes = (prefs && prefs.typeMutes && typeof prefs.typeMutes === 'object') ? prefs.typeMutes : {};
  if (typeMutes[notification.type] === true) {
    await writeEmailLog({
      prisma,
      notification,
      channel: 'DIGEST',
      status: 'SKIPPED_TYPE_MUTED',
    });
    return;
  }

  // Resolve recipient for audit. If we have no email, mark SKIPPED so an
  // operator scanning logs can see WHY the digest would have skipped it.
  let recipientEmail = '';
  try {
    const employee = await prisma.employee.findUnique({
      where: { id: notification.employeeId },
      select: { email: true },
    });
    recipientEmail = employee?.email || '';
  } catch (err) {
    // Non-fatal — we still record the queueing intent.
    console.error('[notify/digest] employee lookup failed', {
      notificationId: notification.id,
      message: err?.message?.split('\n')[0],
    });
  }

  if (!recipientEmail) {
    await writeEmailLog({
      prisma,
      notification,
      channel: 'DIGEST',
      status: 'SKIPPED_NO_ADDRESS',
    });
    return;
  }

  // Record the queueing intent. The digest cron (M2) reads this and the
  // Notification table to build the daily bundle.
  await writeEmailLog({
    prisma,
    notification,
    channel: 'DIGEST',
    status: 'QUEUED',
    recipientEmail,
  });
}

/**
 * Persist one EmailLog row. Never throws — the EmailLog is an audit trail
 * for the email transport, not a critical write path. We log the failure
 * and move on rather than letting audit-write errors mask the original
 * notification.
 */
async function writeEmailLog({ prisma, notification, channel, status, recipientEmail, subject, providerMessageId, errorMessage }) {
  try {
    await prisma.emailLog.create({
      data: {
        employeeId: notification.employeeId,
        notificationId: notification.id || null,
        recipientEmail: recipientEmail || '',
        subject: subject || '',
        channel,
        status,
        providerMessageId: providerMessageId || null,
        errorMessage: errorMessage || null,
      },
    });
  } catch (err) {
    console.error('[notify] email_log insert failed', {
      notificationId: notification?.id,
      status,
      message: err?.message?.split('\n')[0],
    });
  }
}

// ─── prisma accessor ───────────────────────────────────────────────────────
//
// Callers pass the prisma instance explicitly to fanOutEmail so the helper
// stays independent of Express req lifecycle. The setPrisma/getPrisma pair
// remains for the rare caller (a script, an internal job) that wants to
// configure the cache once and forget.

let _cachedPrisma = null;
function setPrisma(p) { _cachedPrisma = p; }
function getPrisma() { return _cachedPrisma; }

/**
 * Round-26: Admin-targeted fan-out.
 *
 * Iterates every active admin (Employee.isAdmin = true) and sends each one
 * an individual email honouring their personal NotificationPreference:
 *   - master emailEnabled = false      → SKIPPED_OPT_OUT
 *   - typeMutes[type] = true           → SKIPPED_TYPE_MUTED
 *   - employee has no email address    → SKIPPED_NO_ADDRESS
 *
 * The audit trail is per-recipient EmailLog rows with channel =
 * 'ADMIN_IMMEDIATE'. Unlike the employee fan-out we do NOT create a
 * Notification row per recipient — admins see submissions via the relevant
 * dashboards (DPR list, inspection queue, leave requests, training), and
 * creating N notification rows per event would balloon the bell.
 *
 * `payload` shape:
 *   {
 *     type: 'ADMIN_DPR_SUBMITTED' | 'ADMIN_INSPECTION_OPENED' | ...,
 *     message: string,             // PII-safe log message (e.g. "New DPR submitted by Rajesh")
 *     meta: { projectName, reportDate, dprId, employeeName, ... }
 *   }
 *
 * Never throws — every per-admin block is wrapped in try/catch so a single
 * misconfigured admin cannot stop the rest of the fan-out.
 */
async function fanOutToAdmins(payload, prisma, context = {}) {
  if (!payload || !payload.type) {
    return { sent: 0, skipped: 0, failed: 0 };
  }
  if (!prisma) {
    console.warn('[notify/admin] fanOutToAdmins called without prisma; skipping');
    return { sent: 0, skipped: 0, failed: 0 };
  }

  let admins;
  try {
    admins = await findActiveAdmins(prisma);
  } catch (err) {
    console.error('[notify/admin] admin lookup failed', {
      type: payload.type,
      message: err?.message?.split('\n')[0],
    });
    return { sent: 0, skipped: 0, failed: 0 };
  }

  if (!isConfigured()) {
    // No RESEND key — record SKIPPED per admin so an operator scanning
    // email_log can see WHY nothing was attempted.
    for (const admin of admins) {
      await writeEmailLog({
        prisma,
        notification: { id: null, employeeId: admin.id },
        channel: 'ADMIN_IMMEDIATE',
        status: 'SKIPPED_OPT_OUT',
        recipientEmail: admin.email || '',
        errorMessage: 'RESEND_API_KEY not set',
      });
    }
    return { sent: 0, skipped: admins.length, failed: 0 };
  }

  // Render once — the HTML is identical for every admin recipient for a
  // given payload. Per-admin variation (name, signature, etc.) is not
  // needed; the chrome footer already addresses the admin user.
  let subject;
  let html;
  try {
    const rendered = renderTemplate(payload.type, {
      notification: { type: payload.type, message: payload.message || '' },
      context: payload.meta || {},
      recipientEmail: '',
    });
    subject = rendered.subject;
    html = rendered.html;
  } catch (err) {
    console.error('[notify/admin] template render failed', {
      type: payload.type,
      message: err?.message?.split('\n')[0],
    });
    for (const admin of admins) {
      await writeEmailLog({
        prisma,
        notification: { id: null, employeeId: admin.id },
        channel: 'ADMIN_IMMEDIATE',
        status: 'FAILED',
        recipientEmail: admin.email || '',
        errorMessage: `template: ${err?.message?.split('\n')[0] || 'unknown'}`,
      });
    }
    return { sent: 0, skipped: 0, failed: admins.length };
  }

  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const admin of admins) {
    try {
      // Per-recipient preference lookup. The volume is small (≤ ~10 admins
      // today); if this grows past ~50 we can batch the prefs lookup via
      // findMany.
      let prefs = null;
      try {
        prefs = await prisma.notificationPreference.findUnique({
          where: { employeeId: admin.id },
        });
      } catch (err) {
        console.error('[notify/admin] preference lookup failed', {
          recipient: hashIdentifier(admin.id),
          message: err?.message?.split('\n')[0],
        });
      }

      // Master kill switch.
      if (prefs && prefs.emailEnabled === false) {
        await writeEmailLog({
          prisma,
          notification: { id: null, employeeId: admin.id },
          channel: 'ADMIN_IMMEDIATE',
          status: 'SKIPPED_OPT_OUT',
        });
        skipped += 1;
        continue;
      }

      // Per-type mute.
      const typeMutes = (prefs && prefs.typeMutes && typeof prefs.typeMutes === 'object') ? prefs.typeMutes : {};
      if (typeMutes[payload.type] === true) {
        await writeEmailLog({
          prisma,
          notification: { id: null, employeeId: admin.id },
          channel: 'ADMIN_IMMEDIATE',
          status: 'SKIPPED_TYPE_MUTED',
        });
        skipped += 1;
        continue;
      }

      const recipientEmail = admin.email || '';
      if (!recipientEmail) {
        await writeEmailLog({
          prisma,
          notification: { id: null, employeeId: admin.id },
          channel: 'ADMIN_IMMEDIATE',
          status: 'SKIPPED_NO_ADDRESS',
          recipientEmail: '',
        });
        skipped += 1;
        continue;
      }

      const result = await sendEmail({ to: recipientEmail, subject, html });
      await writeEmailLog({
        prisma,
        notification: { id: null, employeeId: admin.id },
        channel: 'ADMIN_IMMEDIATE',
        status: result.ok ? 'SENT' : 'FAILED',
        recipientEmail,
        subject,
        providerMessageId: result.messageId || null,
        errorMessage: result.ok ? null : (result.error || `HTTP_${result.statusCode}`),
      });
      if (result.ok) sent += 1; else failed += 1;
    } catch (err) {
      // Defence in depth — a per-admin error must NEVER propagate to the
      // caller (the caller is a POST handler that already returned 201).
      console.error('[notify/admin] per-recipient dispatch failed', {
        recipient: hashIdentifier(admin.id),
        type: payload.type,
        message: err?.message?.split('\n')[0],
      });
      failed += 1;
    }
  }

  return { sent, skipped, failed };
}

module.exports = {
  fanOutEmail,
  fanOutToAdmins,
  sendImmediate,
  enqueueForDigest,
  isCritical,
  CRITICAL_TYPES,
  setPrisma,
  getPrisma,
};
