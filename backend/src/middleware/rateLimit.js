const rateLimit = require('express-rate-limit');

/**
 * Rate-limit policy — defense in depth against brute force, account
 * enumeration, and email bombing (AppSec #8).
 *
 * Keying: per-IP via `req.ip`. Express resolves req.ip from the trusted proxy
 * chain set in index.js (`app.set('trust proxy', 1)`), so the leftmost
 * X-Forwarded-For entry IS the client when the request comes through Azure's
 * load balancer — but the trust is gated by the `trust proxy` setting, not
 * by attacker-controlled headers. (Round-7 fix: dropped the previous custom
 * keyGenerator that read XFF directly, which let any caller spoof their IP
 * by setting their own XFF header.)
 *
 * validate.trustProxy makes express-rate-limit v7 refuse to start if
 * `trust proxy` is misconfigured — catches deployment drift.
 *
 * In-memory store: per-process. Behind multiple App Service instances the
 * per-instance bucket is the unit of enforcement. For an employee-portal
 * scale this is acceptable; if we ever scale out, switch to a Redis store.
 */

const crypto = require('crypto');
const ipKey = (req) => req.ip || 'unknown';

// Hash PII in rate-limit keys so we don't keep raw emails in memory.
// Uses SHA-256 with a per-process pepper; rotate the pepper via env var
// if a leak from a different vector exposes the limit logs.
const PEPPER = process.env.RATE_LIMIT_PEPPER || 'acs-portal-rate-limit-pepper';
function hashEmail(email) {
  if (!email || typeof email !== 'string') return 'unknown';
  return crypto.createHash('sha256').update(PEPPER + ':' + String(email).toLowerCase().trim()).digest('hex').slice(0, 24);
}

// 5 attempts / minute / IP — login. Mounted BEFORE body-parser (at index.js
// mount point) so abusive callers hit the limiter without parsing their
// payload. Defends against IP-level floods; corporate NAT risk is mitigated
// by loginEmailLimiter below.
const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKey,
  validate: { trustProxy: true },
  message: { error: 'Too many login attempts. Please wait a minute and try again.' },
});

// 10 attempts / 15 minutes / IP+email-hash — login. Mounted AFTER body-parser
// at /api/auth/login so the email is parsed. Defends against credential
// stuffing against a single account from many IPs (or a single corporate
// NAT pretending to be many accounts). The email-hash means each unique
// account gets its own 10/15min bucket, and the IP keeps the floor under
// attacker-controlled cross-account bursts. See P1-#12 in the production
// readiness report.
const loginEmailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const ip = req.ip || 'unknown';
    const emailHash = hashEmail(req.body && req.body.email);
    return `${ip}|${emailHash}`;
  },
  validate: { trustProxy: true },
  message: { error: 'Too many login attempts for this account. Please wait and try again.', code: 'LOGIN_THROTTLED' },
});

// 30 / minute / IP — refresh (legitimate users refresh at most once per 8h,
// but if a mobile client flaps, allow short bursts)
const refreshLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKey,
  validate: { trustProxy: true },
  message: { error: 'Too many refresh attempts. Please slow down.' },
});

// 3 / hour / IP — contact form (prevent email bombing)
const contactLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKey,
  validate: { trustProxy: true },
  message: { error: 'Too many submissions. Please try again later.' },
});

// 60 / minute / IP — SAS URL generation (prevent storage exhaustion via
// ticket spamming). One DPR upload may legitimately need several photos.
const sasLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKey,
  validate: { trustProxy: true },
  message: { error: 'Too many upload requests. Please slow down.' },
});

// 10 / hour / IP — Zoho OAuth callback. The popup window itself is trusted,
// but a misconfigured redirect_uri, a misbehaving browser, or a malicious
// script pushing stolen codes can hammer this endpoint. 10/hour is well
// above any legitimate retry pattern (humans retry at most 2-3 times).
const callbackLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKey,
  validate: { trustProxy: true },
  message: { error: 'Too many OAuth callbacks from this address. Please slow down.', code: 'OAUTH_THROTTLED' },
});

// Round-13: 5 / minute / IP — attendance Excel export. HR/admin regenerates
// the file rarely; a runaway button or scripted abuse is the risk.
const exportLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKey,
  validate: { trustProxy: true },
  message: { error: 'Too many export requests. Please wait a minute.', code: 'EXPORT_THROTTLED' },
});

// Round-13: 10 / hour / IP — leave request creation. Legitimate users submit
// at most a handful per month; 10/hour is plenty and stops scripted
// double-submit storms.
const leaveCreateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKey,
  validate: { trustProxy: true },
  message: { error: 'Too many leave submissions. Please try again later.', code: 'LEAVE_THROTTLED' },
});

// Round-14: 120 / hour / IP — training write paths (admin course CRUD +
// bulk-assign + employee progress pings + manual mark-complete). The 120/h
// budget leaves room for ~one progress ping every 30s across a 1h session
// while still blocking scripted spam. GETs (employee "My Learning" hub,
// admin dashboard) are NOT throttled — they're cheap reads.
const trainingWriteLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKey,
  validate: { trustProxy: true },
  message: { error: 'Too many training write requests. Please slow down.', code: 'TRAINING_THROTTLED' },
});

// [Payslips Stage 1 / commit 3, fixup] — 3 payslip-specific limiters.
//
// Why three? The three surfaces have distinct abuse profiles:
//
//   * payslipUploadLimiter (admin uploads): a misbehaving admin tab or a
//     stolen admin token can mint SAS URLs / confirm uploads to fill
//     R2 with junk.
//
//   * payslipAdminLimiter (admin bind / publish / revoke / resend /
//     resend-stuck): the mutating endpoints that stamp audit fields.
//     A scripted admin token can otherwise generate hundreds of
//     EmailLog rows per minute via repeated publish attempts.
//
//   * payslipDownloadLimiter (employee GET /:id/download): the only
//     path that streams the PDF. A script that hammers this endpoint
//     burns CPU + R2 bandwidth; a leaked employee token can otherwise
//     exfiltrate every published payslip in the user's session.
//
// All three key on req.ip via the shared `ipKey` helper.
//
// Sizing for a 15-employee monthly session (the smallest realistic
// payroll cycle — pay-1 v3.10 will support up to ~80 employees but the
// first 1-2 months of usage are well under 20):
//
//   payslipUploadLimiter     40/h   (was 20/h in commit 3, raised)
//   ─────────────────────────────────────────────────────────────
//   Per admin IP per month:
//     15 intents + 15 confirms + 0 SAS-retries (binding CAS auto-retries
//     on the server)  = 30 calls. 40/h comfortably absorbs the burst.
//
//   payslipAdminLimiter      60/h
//   ─────────────────────────────────────────────────────────────
//   Per admin IP per month:
//     15 binds (counted under payslipAdminLimiter via POST /bind),
//     15 publishes (1 per row) + 15 setImmediate email fires (NOT
//     counted — they're background), 0-5 revokes, 0-3 resends,
//     and 0-2 manual resend-stuck sweeps. Worst-case: ~55 in the first
//     hour. 60/h is the floor, not the ceiling.
//
//   payslipDownloadLimiter   120/h
//   ─────────────────────────────────────────────────────────────
//   Per employee IP per month:
//     15 employees × (1 list + 1 download) = 30 calls. UI polling on
//     /api/portal/payslips is the SAME endpoint, so each poll counts.
//     30 calls fits; 120/h leaves room for one download per 30s across
//     an 8h work day if an employee re-downloads several times.
//
//   The 15-emp burst fits all three limiters with headroom. The
//   numbers are pinned in payslip-routes.test.js (D-series) and the
//   rate-limit constants are tested indirectly via the limiter
//   message shape. A burst beyond ~80 employees would require raising
//   the admin limit and/or splitting by employeeId — tracked for the
//   scale-out round.

const payslipUploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKey,
  validate: { trustProxy: true },
  message: { error: 'Too many payslip upload requests. Please slow down.', code: 'PAYSLIP_UPLOAD_THROTTLED' },
});

const payslipAdminLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKey,
  validate: { trustProxy: true },
  message: { error: 'Too many payslip admin operations. Please slow down.', code: 'PAYSLIP_ADMIN_THROTTLED' },
});

const payslipDownloadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  // Key on the authenticated employee id (set by `requireAuth` which
  // runs BEFORE this limiter on every portal route). IP-keying would
  // share the bucket across all employees on a corporate NAT — a
  // single downloader on a shared network could starve a coworker of
  // their 120/h budget. The admin limiters (payslipAdminLimiter,
  // payslipUploadLimiter) keep IP-keying because they're behind
  // requireFreshAdmin and the operators are not a NAT'd user pool.
  // Falls back to ipKey if the limiter is ever mounted on a route
  // without requireAuth (the mount order is enforced at the route
  // layer — this is the safety net for a future re-arrangement).
  keyGenerator: (req) => (req && req.employeeId ? `emp:${req.employeeId}` : ipKey(req)),
  validate: { trustProxy: true },
  message: { error: 'Too many payslip download requests. Please slow down.', code: 'PAYSLIP_DOWNLOAD_THROTTLED' },
});

module.exports = {
  loginLimiter,
  loginEmailLimiter,
  refreshLimiter,
  contactLimiter,
  sasLimiter,
  callbackLimiter,
  exportLimiter,
  leaveCreateLimiter,
  trainingWriteLimiter,
  payslipUploadLimiter,
  payslipAdminLimiter,
  payslipDownloadLimiter,
};
