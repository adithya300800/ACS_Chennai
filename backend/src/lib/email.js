// Round-25: transactional-email client.
//
// Thin wrapper around the Resend HTTPS API (`api.resend.com/emails`). Chosen
// over SMTP because Render's free plan blocks outbound TCP/587 (and most
// other SMTP ports) — an outbound ETIMEDOUT kills every send. HTTPS egress
// on 443 is unrestricted. Resend's free tier (100 emails/day, 3K/mo) covers
// our notification volume; the contact form already uses the same path.
//
// Why not ZeptoMail / SES / Zoho SMTP: each requires either paid send volume
// or SMTP egress, both ruled out. Resend reuses the verified domain
// `acschennai.com` (already wired for the contact form via
// `RESEND_FROM_EMAIL=info@acschennai.com`).
//
// Failure mode: NEVER throw. Callers wrap the call in their own try/catch
// but this module logs structured `[email]` lines and returns
// `{ ok: false, error, statusCode }` on any failure so a single misconfigured
// send can't crash the user-facing request. The audit trail lives in
// EmailLog (written by the caller); this module only logs to stdout.

const { Resend } = require('resend');
const { hashIdentifier } = require('./pii');

// All env vars are required for a working send. They stay backend-only —
// the frontend never reads these (no VITE_ prefix). Reuse the same names
// the contact form already documents so we have ONE set of env vars for
// outbound email, not two.
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'info@acschennai.com';
const FROM_NAME = process.env.RESEND_FROM_NAME || 'ACS Chennai Portal';

// Module-level Resend client. Resend's SDK uses fetch internally and pools
// HTTP/2 connections on Node ≥18, so a single client across all sends is
// the right shape.
let _client = null;
function getClient() {
  if (_client) return _client;
  if (!RESEND_API_KEY) return null;
  _client = new Resend(RESEND_API_KEY);
  return _client;
}

function isConfigured() {
  return Boolean(RESEND_API_KEY);
}

/**
 * Escape an arbitrary string for safe interpolation into HTML email bodies.
 * Email clients vary wildly in built-in sanitization — escape explicitly.
 * Re-exported so `templates/email/types.js` can share one contract with the
 * contact form.
 */
function escapeHtml(value) {
  if (value == null) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Send one transactional email via Resend. Returns:
 *   { ok: true, messageId }
 *   { ok: false, error, statusCode }
 *
 * Never throws. The `to` field is hashed for the log line so PII never
 * lands in stdout; the full address is returned inside EmailLog (where the
 * caller controls what's persisted).
 */
async function sendEmail({ to, subject, html, replyTo }) {
  const recipientHash = hashIdentifier(to);
  if (!isConfigured()) {
    console.log('[email] skipped (not configured)', { recipient: recipientHash, subject });
    return { ok: false, error: 'NOT_CONFIGURED', statusCode: 0 };
  }
  if (!to || typeof to !== 'string' || !to.includes('@')) {
    console.warn('[email] skipped (no address)', { recipient: recipientHash, subject });
    return { ok: false, error: 'NO_ADDRESS', statusCode: 0 };
  }
  if (!subject || !html) {
    console.warn('[email] skipped (missing subject or html)', { recipient: recipientHash });
    return { ok: false, error: 'INVALID_PAYLOAD', statusCode: 0 };
  }

  const client = getClient();
  if (!client) {
    return { ok: false, error: 'TRANSPORTER_UNAVAILABLE', statusCode: 0 };
  }

  try {
    const { data, error } = await client.emails.send({
      from: `"${FROM_NAME}" <${FROM_EMAIL}>`,
      to,
      subject,
      html,
      ...(replyTo ? { replyTo } : {}),
    });
    if (error) {
      console.error('[email] send failed', {
        recipient: recipientHash,
        subject,
        statusCode: error.statusCode,
        message: error.message?.split('\n')[0],
        name: error.name,
      });
      return { ok: false, error: error.message || 'UNKNOWN', statusCode: error.statusCode || 0 };
    }
    console.log('[email] sent', {
      recipient: recipientHash,
      subject,
      messageId: data?.id,
    });
    return { ok: true, messageId: data?.id };
  } catch (err) {
    // The Resend SDK normally returns errors via the `{ error }` destructure,
    // but unexpected throws (network drop, malformed payload) land here.
    console.error('[email] send threw', {
      recipient: recipientHash,
      subject,
      code: err?.code,
      message: err?.message?.split('\n')[0],
    });
    return { ok: false, error: err?.message || 'UNKNOWN', statusCode: err?.statusCode || 0 };
  }
}

/**
 * Graceful shutdown — placeholder for the old nodemailer pool. Resend's
 * SDK is stateless so there's nothing to close, but we keep the symbol so
 * src/index.js's shutdown handler doesn't have to special-case this module.
 */
async function close() {
  _client = null;
}

module.exports = {
  sendEmail,
  escapeHtml,
  isConfigured,
  close,
  FROM_EMAIL,
  FROM_NAME,
};
