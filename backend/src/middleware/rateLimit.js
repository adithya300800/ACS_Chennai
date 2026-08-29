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

const ipKey = (req) => req.ip || 'unknown';

// 5 attempts / minute / IP — login
const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKey,
  validate: { trustProxy: true },
  message: { error: 'Too many login attempts. Please wait a minute and try again.' },
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

module.exports = {
  loginLimiter,
  refreshLimiter,
  contactLimiter,
  sasLimiter,
};
