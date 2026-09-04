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

// LPR-010: audit-status vocabulary. The EmailLog.status column is a free-
// form String (schema.prisma line 578) so we can introduce new values
// without a migration. SKIPPED_OPT_OUT is reserved for *user-driven* opt-
// outs (emailEnabled=false or digestEnabled=false). SKIPPED_NOT_CONFIGURED
// covers the case where the operator hasn't provisioned a transport
// (RESEND_API_KEY unset) — semantically distinct from an opt-out so the
// audit log doesn't lie about why nothing was attempted.
const STATUS_SENT = 'SENT';
const STATUS_FAILED = 'FAILED';
const STATUS_SKIPPED_OPT_OUT = 'SKIPPED_OPT_OUT';
const STATUS_SKIPPED_TYPE_MUTED = 'SKIPPED_TYPE_MUTED';
const STATUS_SKIPPED_NO_ADDRESS = 'SKIPPED_NO_ADDRESS';
const STATUS_SKIPPED_NOT_CONFIGURED = 'SKIPPED_NOT_CONFIGURED';
const STATUS_QUEUED = 'QUEUED';

function isCritical(type) {
  return CRITICAL_TYPES.has(type);
}

/**
 * LPR-010: canonical "should we even try to send?" policy. Previously each
 * call site (immediate fan-out, admin fan-out, digest enqueue) had its own
 * ad-hoc sequence of `if (prefs && prefs.emailEnabled === false) ...` and
 * missed the digestEnabled check on the immediate path, leading to a
 * divergent contract between what the UI promised and what the backend
 * honoured. One helper returns a uniform verdict so adding a new toggle
 * (or honouring a per-type master) is a one-line change.
 *
 *   channel: 'IMMEDIATE' | 'DIGEST' | 'ADMIN_IMMEDIATE' | 'ADMIN_DIGEST'
 *
 * Returns:
 *   { skip: true, status, errorMessage? }  → caller writes an EmailLog
 *   { skip: false }                        → caller continues to render+send
 *
 * A *missing* prefs row is treated as fully enabled (matches the defaults
 * the notifications API already serialises) so digest employee selection
 * doesn't drop rows that have no NotificationPreference yet.
 */
function shouldSkipSend(prefs, type, channel) {
  const safePrefs = prefs && typeof prefs === 'object' ? prefs : {};
  const isAdminChannel = channel === 'ADMIN_IMMEDIATE' || channel === 'ADMIN_DIGEST';

  // Master kill switch: emailEnabled. A missing row or undefined is enabled.
  if (safePrefs.emailEnabled === false) {
    return { skip: true, status: STATUS_SKIPPED_OPT_OUT, errorMessage: 'email disabled' };
  }

  // Digest master switch: only applies to digest-class channels so an
  // employee with digestEnabled=false still receives immediate notifications.
  if ((channel === 'DIGEST' || channel === 'ADMIN_DIGEST') && safePrefs.digestEnabled === false) {
    return { skip: true, status: STATUS_SKIPPED_OPT_OUT, errorMessage: 'digest disabled' };
  }

  // Per-type mute (default = not muted).
  const typeMutes = (safePrefs.typeMutes && typeof safePrefs.typeMutes === 'object') ? safePrefs.typeMutes : {};
  if (typeMutes[type] === true) {
    return { skip: true, status: STATUS_SKIPPED_TYPE_MUTED, errorMessage: `type ${type} muted` };
  }

  return { skip: false };
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
 * Honours four opt-out signals before attempting to send:
 *   1. master emailEnabled = false         → SKIPPED_OPT_OUT
 *   2. master digestEnabled = false (only on digest channels)  → SKIPPED_OPT_OUT
 *   3. typeMutes[type] = true              → SKIPPED_TYPE_MUTED
 *   4. employee has no email address       → SKIPPED_NO_ADDRESS
 *
 * LPR-010: gate logic funnels through shouldSkipSend() — the same helper
 * the admin + digest paths use — so a toggle change is a one-line edit.
 * Unconfigured transport (RESEND_API_KEY unset) now records
 * SKIPPED_NOT_CONFIGURED (formerly misclassified as SKIPPED_OPT_OUT, which
 * lied about why nothing was attempted).
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

  const verdict = shouldSkipSend(prefs, notification.type, 'IMMEDIATE');
  if (verdict.skip) {
    await writeEmailLog({
      prisma,
      notification,
      channel: 'IMMEDIATE',
      status: verdict.status,
      errorMessage: verdict.errorMessage || null,
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
    // LPR-010: previously recorded as SKIPPED_OPT_OUT — incorrect; the
    // user did NOT opt out, the operator forgot to provision a transport.
    // SKIPPED_NOT_CONFIGURED is the accurate audit status so dashboards
    // / alerts can distinguish "we deliberately didn't email this user"
    // from "we'd have emailed them if RESEND_API_KEY were set".
    await writeEmailLog({
      prisma,
      notification,
      channel: 'IMMEDIATE',
      status: STATUS_SKIPPED_NOT_CONFIGURED,
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
      status: STATUS_FAILED,
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
    status: result.ok ? STATUS_SENT : STATUS_FAILED,
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
 * (status = QUEUED, so an operator scanning email_log can see the intent
 * even before the digest cron ships).
 *
 * LPR-010: gate logic funnels through shouldSkipSend() so emailEnabled,
 * digestEnabled, and typeMutes all check in one canonical place.
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

  const verdict = shouldSkipSend(prefs, notification.type, 'DIGEST');
  if (verdict.skip) {
    await writeEmailLog({
      prisma,
      notification,
      channel: 'DIGEST',
      status: verdict.status,
      errorMessage: verdict.errorMessage || null,
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
    status: STATUS_QUEUED,
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
    // No RESEND key — record SKIPPED_NOT_CONFIGURED per admin so an operator
    // scanning email_log can see WHY nothing was attempted. LPR-010: was
    // previously misclassified as SKIPPED_OPT_OUT.
    for (const admin of admins) {
      await writeEmailLog({
        prisma,
        notification: { id: null, employeeId: admin.id },
        channel: 'ADMIN_IMMEDIATE',
        status: STATUS_SKIPPED_NOT_CONFIGURED,
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

      // LPR-010: route the per-recipient gate through shouldSkipSend() so
      // emailEnabled / digestEnabled / typeMutes all check in one place.
      const verdict = shouldSkipSend(prefs, payload.type, 'ADMIN_IMMEDIATE');
      if (verdict.skip) {
        await writeEmailLog({
          prisma,
          notification: { id: null, employeeId: admin.id },
          channel: 'ADMIN_IMMEDIATE',
          status: verdict.status,
          errorMessage: verdict.errorMessage || null,
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
        status: result.ok ? STATUS_SENT : STATUS_FAILED,
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
  STATUS_SENT,
  STATUS_FAILED,
  STATUS_SKIPPED_OPT_OUT,
  STATUS_SKIPPED_TYPE_MUTED,
  STATUS_SKIPPED_NO_ADDRESS,
  STATUS_SKIPPED_NOT_CONFIGURED,
  STATUS_QUEUED,
  shouldSkipSend,
  setPrisma,
  getPrisma,
};
