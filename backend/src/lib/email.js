// Round-25: SMTP transactional-email client (Zoho Mail).
//
// Thin wrapper around nodemailer's SMTP transport pointed at Zoho Mail
// (`smtp.zoho.com:587`, TLS). Reuses the existing acschennai.com Zoho Mail
// subscription — no new account, no new DNS, no per-email billing.
//
// Why Zoho SMTP (not ZeptoMail / Resend): the user already has Zoho Mail
// configured for the acschennai.com domain (verified, deliverable). Creating
// a dedicated `noreply@acschennai.com` mailbox in Zoho Mail and authenticating
// to its SMTP server with a Zoho App Password is free, leverages the same
// trust boundary they already accept, and gives us 150 emails/day on the free
// Zoho Mail plan (much more on Standard).
//
// Setup (one-time, in Zoho Mail web UI):
//   1. Create the mailbox `noreply@acschennai.com` (or reuse an existing one).
//   2. Settings → Security → App Passwords → generate a "Backend SMTP" app
//      password. Zoho's regular mailbox password does NOT work for SMTP
//      when 2FA is on — app passwords are the supported auth path.
//   3. Set the env vars below on the Render dashboard.
//
// Failure mode: NEVER throw. Callers wrap the call in their own try/catch
// but this module logs structured `[email]` lines and returns
// `{ ok: false, error }` on any failure so a single misconfigured send
// can't crash the user-facing request. The audit trail lives in EmailLog
// (written by the caller); this module only logs to stdout.

const nodemailer = require('nodemailer');
const { hashIdentifier } = require('./pii');

// All env vars are required for a working send. They stay backend-only —
// the frontend never reads these (no VITE_ prefix).
const ZOHO_SMTP_HOST = process.env.ZOHO_SMTP_HOST || 'smtp.zoho.com';
const ZOHO_SMTP_PORT = parseInt(process.env.ZOHO_SMTP_PORT || '587', 10);
const ZOHO_SMTP_USER = process.env.ZOHO_SMTP_USER || '';         // e.g. noreply@acschennai.com
const ZOHO_SMTP_PASSWORD = process.env.ZOHO_SMTP_PASSWORD || ''; // Zoho App Password, NOT the regular password
const ZOHO_SMTP_SECURE = String(process.env.ZOHO_SMTP_SECURE || 'false').toLowerCase() === 'true'; // true only for port 465

const FROM_EMAIL = process.env.FROM_EMAIL || ZOHO_SMTP_USER || 'noreply@acschennai.com';
const FROM_NAME = process.env.FROM_NAME || 'ACS Chennai Portal';

// Module-level transporter. nodemailer pools SMTP connections internally,
// so creating one at boot and reusing it across all sends avoids the
// per-email handshake cost (~100ms TCP+TLS each on cold connections).
let _transporter = null;
function getTransporter() {
  if (_transporter) return _transporter;
  if (!ZOHO_SMTP_USER || !ZOHO_SMTP_PASSWORD) return null;
  _transporter = nodemailer.createTransport({
    host: ZOHO_SMTP_HOST,
    port: ZOHO_SMTP_PORT,
    secure: ZOHO_SMTP_SECURE, // true for 465 (immediate TLS), false for 587 (STARTTLS)
    auth: {
      user: ZOHO_SMTP_USER,
      pass: ZOHO_SMTP_PASSWORD,
    },
    // Defensive pool limits — Zoho's free-tier SMTP rate is ~150/day per
    // mailbox, so we never need more than a couple of in-flight sends.
    pool: true,
    maxConnections: 2,
    maxMessages: 50,
    // 15s upper bound per send so a hung SMTP connection can't block
    // the request indefinitely. Zoho's typical p99 is <2s.
    connectionTimeout: 10_000,
    socketTimeout: 15_000,
    tls: {
      // Zoho's certificate is signed by a public CA — no need to disable
      // verification. Keep the default (`rejectUnauthorized: true`).
    },
  });
  return _transporter;
}

function isConfigured() {
  return Boolean(ZOHO_SMTP_USER && ZOHO_SMTP_PASSWORD);
}

// Round-25b debug: log env state once at module load so we can prove the
// running service picked up ZOHO_SMTP_USER / ZOHO_SMTP_PASSWORD without
// leaking the password itself. Strip on next round.
const _bootState = {
  user_set: !!ZOHO_SMTP_USER,
  user_len: ZOHO_SMTP_USER.length,
  pass_len: ZOHO_SMTP_PASSWORD.length,
  from_email: FROM_EMAIL,
  host: ZOHO_SMTP_HOST,
  port: ZOHO_SMTP_PORT,
};
console.log('[email] module loaded', _bootState);

/**
 * Escape an arbitrary string for safe interpolation into HTML email bodies.
 * Email clients vary wildly in built-in sanitization — escape explicitly.
 * Lifted from backend/src/routes/contact.js so templates and the contact
 * form share one HTML-escape contract.
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
 * Send one transactional email via Zoho SMTP. Returns:
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

  const transporter = getTransporter();
  if (!transporter) {
    return { ok: false, error: 'TRANSPORTER_UNAVAILABLE', statusCode: 0 };
  }

  try {
    const info = await transporter.sendMail({
      from: `"${FROM_NAME}" <${FROM_EMAIL}>`,
      to,
      subject,
      html,
      ...(replyTo ? { replyTo } : {}),
    });
    // nodemailer returns { messageId, envelope, accepted, rejected, response }.
    // `accepted` is the array of addresses the server accepted for delivery.
    // An empty `accepted` means the server 250'd the envelope but didn't
    // queue the message — treat as failure rather than success.
    const accepted = Array.isArray(info.accepted) ? info.accepted : [];
    const rejected = Array.isArray(info.rejected) ? info.rejected : [];
    if (rejected.length > 0 || accepted.length === 0) {
      console.error('[email] server rejected', {
        recipient: recipientHash,
        subject,
        rejected,
        response: info.response?.split('\n')[0],
      });
      return { ok: false, error: `REJECTED: ${rejected.join(',')}`, statusCode: 0 };
    }
    console.log('[email] sent', {
      recipient: recipientHash,
      subject,
      messageId: info.messageId,
    });
    return { ok: true, messageId: info.messageId };
  } catch (err) {
    // nodemailer errors carry a numeric `responseCode` for SMTP status
    // (e.g. 535 auth failed, 550 mailbox unavailable). Log the message
    // + code so an operator can triage from stdout alone.
    console.error('[email] send failed', {
      recipient: recipientHash,
      subject,
      code: err?.responseCode || err?.code,
      message: err?.message?.split('\n')[0],
    });
    return { ok: false, error: err?.message || 'UNKNOWN', statusCode: err?.responseCode || 0 };
  }
}

/**
 * Graceful shutdown — close the SMTP pool so the process can exit
 * cleanly. Called from the existing shutdown handler in src/index.js.
 */
async function close() {
  if (_transporter) {
    try { _transporter.close(); } catch (_) { /* ignore */ }
    _transporter = null;
  }
}

module.exports = {
  sendEmail,
  escapeHtml,
  isConfigured,
  close,
  FROM_EMAIL,
  FROM_NAME,
};
