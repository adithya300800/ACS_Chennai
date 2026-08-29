const crypto = require('crypto');

/**
 * PII redaction helpers (GDPR / India DPDP Act compliance).
 *
 * Don't log raw email addresses, phone numbers, or other PII to stdout — they
 * end up in Azure Log Stream, Application Insights, and any log-aggregator
 * the operator hasn't yet wired up. Log a stable hash instead so we can
 * correlate events for the same user without exposing the identifier.
 *
 * The salt is a deploy-time secret so an attacker who scrapes logs can't
 * recover the email by hashing common words.
 */

let _salt;
function salt() {
  if (!_salt) {
    _salt = process.env.PII_LOG_SALT
      || (process.env.NODE_ENV === 'production'
            ? crypto.randomBytes(16).toString('hex')
            : 'dev-only-salt-not-for-production');
  }
  return _salt;
}

/**
 * Hash an identifier (email, phone, employeeId, etc.) into a short opaque
 * token for logging. Stable for the same input + salt, irreversible without
 * the salt.
 */
function hashIdentifier(value) {
  if (value == null) return null;
  return crypto
    .createHmac('sha256', salt())
    .update(String(value).toLowerCase().trim())
    .digest('hex')
    .slice(0, 12);
}

/**
 * Drop PII fields from an object, replacing common PII keys with their hash.
 * Use before logging request bodies.
 */
function redact(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const clone = Array.isArray(obj) ? [...obj] : { ...obj };
  for (const key of Object.keys(clone)) {
    if (/email|phone|address|ssn|pan|aadhaar/i.test(key) && typeof clone[key] === 'string') {
      clone[key] = hashIdentifier(clone[key]);
    } else if (clone[key] && typeof clone[key] === 'object') {
      clone[key] = redact(clone[key]);
    }
  }
  return clone;
}

module.exports = { hashIdentifier, redact };
