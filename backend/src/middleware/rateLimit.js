const rateLimit = require('express-rate-limit');

/**
 * Rate-limit policy — defense in depth against brute force, account
 * enumeration, and email bombing (AppSec #8).
 *
 * Why per-IP (not per-account): the login route must be guarded BEFORE we
 * know which account is being targeted. Per-IP is the only safe default.
 * `trust proxy: 1` is set in index.js so req.ip reflects the client.
 *
 * Each limiter sets standard `RateLimit-*` headers. WindowMS is sized so that
 * transient bursts (e.g. reconnecting, double-click) don't trip the limit, but
 * sustained abuse does.
 */

// 5 attempts / minute / IP — login
const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please wait a minute and try again.' },
});

// 30 / minute / IP — refresh (legitimate users refresh at most once per 8h,
// but if a mobile client flaps, allow short bursts)
const refreshLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many refresh attempts. Please slow down.' },
});

// 3 / hour / IP — contact form (prevent email bombing)
const contactLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many submissions. Please try again later.' },
});

// 60 / minute / IP — SAS URL generation (prevent storage exhaustion via
// ticket spamming). One DPR upload may legitimately need several photos.
const sasLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many upload requests. Please slow down.' },
});

module.exports = {
  loginLimiter,
  refreshLimiter,
  contactLimiter,
  sasLimiter,
};
