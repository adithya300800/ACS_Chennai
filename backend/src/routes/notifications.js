// Round-25: Notification preferences API.
//
// Endpoints:
//   GET    /api/notifications/preferences       — current user's prefs (defaults if no row)
//   PUT    /api/notifications/preferences       — partial update of emailEnabled, digestEnabled,
//                                                  typeMutes, digestHourLocal
//   POST   /api/notifications/test              — admin-only; sends a "this is a test email"
//                                                  to the admin's own mailbox to verify the
//                                                  SMTP wire (Zoho credentials, deliverability)
//
// Auth model:
//   - requireAuth on all routes.
//   - POST /test is requireFreshAdmin — only an admin can probe SMTP creds.
//   - The other two routes are per-employee (no admin gating); an employee
//     reads + mutates ONLY their own row (employeeId from req.employeeId).
//
// Storage shape:
//   { emailEnabled, digestEnabled, typeMutes: { TYPE: true }, digestHourLocal }
//   Defaults: { emailEnabled: true, digestEnabled: true, typeMutes: {}, digestHourLocal: 8 }
//
// typeMutes validation: every key must be one of ALLOWED_NOTIFICATION_TYPES.
// Unknown keys are rejected with 400 — prevents a typo'd "DPR_REVIEW" (should
// be "DPR_REVIEWED") from silently never muting the intended type.

'use strict';

const express = require('express');
const router = express.Router();
const { requireAuth, requireFreshAdmin } = require('../middleware/auth');
const { hashIdentifier } = require('../lib/pii');
const { sendEmail } = require('../lib/email');

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function getPrisma(req) { return req.app.get('prisma'); }

// Single source of truth for the 11 active notification types. Mirrors the
// CRITICAL_TYPES set in lib/notify.js (the digest set is just the complement).
// Adding a new type means (a) add it here, (b) add it to lib/notify.js's
// CRITICAL_TYPES if it's critical, (c) add a template in
// backend/src/templates/email/types.js.
const ALLOWED_NOTIFICATION_TYPES = new Set([
  'TRAINING_ASSIGNED',     // IMMEDIATE
  'TRAINING_CANCELLED',    // IMMEDIATE
  'TRAINING_IN_PROGRESS',  // DAILY
  'TRAINING_COMPLETED',    // DAILY
  'DPR_REVIEWED',          // DAILY
  'DPR_APPROVED',          // IMMEDIATE
  'DPR_REJECTED',          // IMMEDIATE
  'INSPECTION_ACKNOWLEDGED', // DAILY
  'INSPECTION_CLOSED',     // DAILY
  'INSPECTION_REJECTED',   // IMMEDIATE
  'LEAVE_DECIDED',         // DAILY
]);

// Human-friendly labels for the preferences UI. Order matters — this is the
// order the toggles appear on the page.
const NOTIFICATION_LABELS = [
  { type: 'DPR_APPROVED',          label: 'DPR approved',          channel: 'IMMEDIATE', description: 'You receive an email the moment your daily progress report is approved.' },
  { type: 'DPR_REJECTED',          label: 'DPR rejected',          channel: 'IMMEDIATE', description: 'You receive an email the moment your daily progress report is rejected.' },
  { type: 'DPR_REVIEWED',          label: 'DPR reviewed',          channel: 'DAILY',     description: 'A daily digest summary of any admin reviews you have not yet seen.' },
  { type: 'INSPECTION_REJECTED',   label: 'Inspection rejected',   channel: 'IMMEDIATE', description: 'You receive an email the moment one of your inspections is rejected.' },
  { type: 'INSPECTION_ACKNOWLEDGED', label: 'Inspection acknowledged', channel: 'DAILY', description: 'A daily digest of inspections an admin has acknowledged.' },
  { type: 'INSPECTION_CLOSED',     label: 'Inspection closed',     channel: 'DAILY',     description: 'A daily digest of inspections an admin has closed.' },
  { type: 'LEAVE_DECIDED',         label: 'Leave decision',        channel: 'DAILY',     description: 'A daily digest of any leave approve/reject decisions.' },
  { type: 'TRAINING_ASSIGNED',     label: 'Training assigned',     channel: 'IMMEDIATE', description: 'You receive an email the moment an admin assigns a course to you.' },
  { type: 'TRAINING_CANCELLED',    label: 'Training unassigned',   channel: 'IMMEDIATE', description: 'You receive an email the moment an admin cancels a course assignment.' },
  { type: 'TRAINING_IN_PROGRESS',  label: 'Training started',      channel: 'DAILY',     description: 'A daily digest of courses you started watching.' },
  { type: 'TRAINING_COMPLETED',    label: 'Training completed',    channel: 'DAILY',     description: 'A daily digest of courses you completed.' },
];

const DEFAULT_PREFS = {
  emailEnabled: true,
  digestEnabled: true,
  typeMutes: {},
  digestHourLocal: 8,
};

function serializePrefs(row) {
  if (!row) return { ...DEFAULT_PREFS };
  return {
    emailEnabled: row.emailEnabled,
    digestEnabled: row.digestEnabled,
    typeMutes: (row.typeMutes && typeof row.typeMutes === 'object') ? row.typeMutes : {},
    digestHourLocal: row.digestHourLocal,
    updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null,
  };
}

function validatePrefsBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, code: 'INVALID_BODY', message: 'Body must be a JSON object' };
  }
  const allowed = ['emailEnabled', 'digestEnabled', 'typeMutes', 'digestHourLocal'];
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) {
      return { ok: false, code: 'UNKNOWN_FIELD', message: `Unknown field: ${key}` };
    }
  }
  if ('emailEnabled' in body && typeof body.emailEnabled !== 'boolean') {
    return { ok: false, code: 'INVALID_EMAIL_ENABLED', message: 'emailEnabled must be a boolean' };
  }
  if ('digestEnabled' in body && typeof body.digestEnabled !== 'boolean') {
    return { ok: false, code: 'INVALID_DIGEST_ENABLED', message: 'digestEnabled must be a boolean' };
  }
  if ('typeMutes' in body) {
    if (!body.typeMutes || typeof body.typeMutes !== 'object' || Array.isArray(body.typeMutes)) {
      return { ok: false, code: 'INVALID_TYPE_MUTES', message: 'typeMutes must be an object' };
    }
    for (const [type, muted] of Object.entries(body.typeMutes)) {
      if (!ALLOWED_NOTIFICATION_TYPES.has(type)) {
        return { ok: false, code: 'UNKNOWN_TYPE', message: `Unknown notification type: ${type}` };
      }
      if (typeof muted !== 'boolean') {
        return { ok: false, code: 'INVALID_TYPE_MUTE', message: `typeMutes.${type} must be a boolean` };
      }
    }
  }
  if ('digestHourLocal' in body) {
    if (!Number.isInteger(body.digestHourLocal) || body.digestHourLocal < 0 || body.digestHourLocal > 23) {
      return { ok: false, code: 'INVALID_DIGEST_HOUR', message: 'digestHourLocal must be an integer 0-23' };
    }
  }
  return { ok: true, value: body };
}

router.use(requireAuth);

// ─── GET /api/notifications/preferences ────────────────────────────────────
// Returns the current user's preferences. If no row exists yet (the user has
// never opened the preferences page or has no EmailLog yet), we return the
// defaults. The frontend treats a null row identically to a row with all
// defaults — defaults are deliberately "all on" so the portal stays
// permissive until the user actively opts out.
router.get('/preferences', asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  const row = await prisma.notificationPreference.findUnique({
    where: { employeeId: req.employeeId },
  });
  res.json({
    preferences: serializePrefs(row),
    types: NOTIFICATION_LABELS,
  });
}));

// ─── PUT /api/notifications/preferences ────────────────────────────────────
// Idempotent upsert. Only the fields present in the body are touched.
// Unknown fields are rejected (so a stale client sending a now-removed key
// gets a clean 400 instead of a silent ignore).
router.put('/preferences', asyncHandler(async (req, res) => {
  const result = validatePrefsBody(req.body);
  if (!result.ok) {
    return res.status(400).json({ error: result.message, code: result.code });
  }
  const prisma = getPrisma(req);
  // Build a Prisma write object that only touches the fields actually sent.
  // Missing fields fall through to the schema defaults on first create, or
  // stay untouched on subsequent updates.
  const data = {
    employeeId: req.employeeId,
    ...(typeof result.value.emailEnabled === 'boolean' ? { emailEnabled: result.value.emailEnabled } : {}),
    ...(typeof result.value.digestEnabled === 'boolean' ? { digestEnabled: result.value.digestEnabled } : {}),
    ...(result.value.typeMutes ? { typeMutes: result.value.typeMutes } : {}),
    ...(Number.isInteger(result.value.digestHourLocal) ? { digestHourLocal: result.value.digestHourLocal } : {}),
  };
  // Upsert: if the row exists, only the fields in `data` are touched; if
  // not, the rest fall to the schema default. Prisma's upsert with no
  // separate `create` block means the create side uses the full record —
  // we still want the @default values for missing fields, so supply them.
  const row = await prisma.notificationPreference.upsert({
    where: { employeeId: req.employeeId },
    update: data,
    create: {
      ...DEFAULT_PREFS,
      ...data,
      typeMutes: result.value.typeMutes || {},
    },
  });
  console.log('[notifications/preferences] updated', {
    employee: hashIdentifier(req.employeeId),
    fields: Object.keys(result.value),
  });
  res.json({ preferences: serializePrefs(row) });
}));

// ─── POST /api/notifications/test ──────────────────────────────────────────
// Admin-only. Sends one email to the admin's own mailbox with a fixed
// subject so a green-row operator can verify the SMTP wire end-to-end without
// having to trigger a real DPR approve/reject from the UI.
//
// On success: { ok: true, messageId }
// On failure: 503 with the underlying SMTP error so the admin can copy/paste
// it into a status-page report. We do NOT mask the error.
router.post('/test', requireFreshAdmin, asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  const employee = await prisma.employee.findUnique({
    where: { id: req.employeeId },
    select: { email: true, name: true },
  });
  if (!employee || !employee.email) {
    return res.status(400).json({ error: 'Admin has no email on file', code: 'NO_EMAIL' });
  }
  const html = `<!doctype html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;padding:24px;color:#111;">
  <h1 style="color:#0a2540;font-size:18px;">ACS Portal email — test send ✓</h1>
  <p>Hi ${employee.name || 'admin'},</p>
  <p>This is a test email sent from the <strong>ACS Chennai Portal</strong> via Zoho Mail SMTP.</p>
  <p>If you are reading this, the SMTP credentials (ZOHO_SMTP_USER, ZOHO_SMTP_PASSWORD) are configured correctly and the deliverability path from <code>smtp.zoho.com</code> → <code>${employee.email}</code> is open.</p>
  <p style="font-size:12px;color:#6b7280;margin-top:24px;">Sent at ${new Date().toISOString()}</p>
</body></html>`;
  const subject = '[ACS Portal] SMTP test send ✓';
  const result = await sendEmail({ to: employee.email, subject, html });
  if (!result.ok) {
    console.warn('[notifications/test] send failed', {
      admin: hashIdentifier(req.employeeId),
      error: result.error,
      statusCode: result.statusCode,
    });
    return res.status(503).json({
      error: 'Email send failed',
      code: 'EMAIL_SEND_FAILED',
      detail: result.error,
      statusCode: result.statusCode,
    });
  }
  console.log('[notifications/test] sent', {
    admin: hashIdentifier(req.employeeId),
    to: employee.email,
    messageId: result.messageId,
  });
  res.json({ ok: true, messageId: result.messageId, to: employee.email });
}));

module.exports = router;
module.exports.ALLOWED_NOTIFICATION_TYPES = ALLOWED_NOTIFICATION_TYPES;
module.exports.NOTIFICATION_LABELS = NOTIFICATION_LABELS;
