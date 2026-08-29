const rateLimit = require('express-rate-limit');

/**
 * Rate-limit policy — defense in depth against brute force, account
 * enumeration, and email bombing (AppSec #8).
 *
 * Keying: per-IP by default. When `trust proxy` is on (it is, in index.js),
 * `req.ip` reflects the connecting client. We also provide an explicit
 * keyGenerator that prefers X-Forwarded-For's first IP if present, so the
 * limiter behaves identically whether or not Azure's load balancer rewrites
 * the connection source.
 *
 * In-memory store: per-process. Behind multiple App Service instances the
 * per-instance bucket is the unit of enforcement. For an employee-portal
 * scale this is acceptable; if we ever scale out, switch to a Redis store.
 */

function ipKey(req) {
  // Prefer the first hop in X-Forwarded-For if present (Azure App Service
  // sets this); fall back to req.ip which Express computes from the socket.
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    return xff.split(',')[0].trim();
  }
  return req.ip || req.connection?.remoteAddress || 'unknown';
}

// 5 attempts / minute / IP — login
const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKey,
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
  message: { error: 'Too many refresh attempts. Please slow down.' },
});

// 3 / hour / IP — contact form (prevent email bombing)
const contactLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKey,
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
  message: { error: 'Too many upload requests. Please slow down.' },
});

module.exports = {
  loginLimiter,
  refreshLimiter,
  contactLimiter,
  sasLimiter,
};
