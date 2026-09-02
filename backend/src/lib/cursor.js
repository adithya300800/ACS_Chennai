/**
 * Cursor codec for keyset pagination over (reportDate DESC, id DESC).
 *
 * DR-008 root cause: the previous wire format encoded the cursor as
 * `base64(<ISO timestamp>|<id>)` but the decoder validated the date as
 * YYYY-MM-DD. The round-trip broke on page 2 — every cursor produced
 * `INVALID_CURSOR` once the queue exceeded the page size, making older
 * records unreachable.
 *
 * This codec fixes the contract so encoder + decoder agree on
 * `base64url(JSON.stringify({ date: 'YYYY-MM-DD', id }))`. The date is
 * always a date-only string (matching the Postgres @db.Date column type
 * and Prisma's coerced Date instance for it) so the wire format and the
 * SQL seek predicate line up.
 *
 * Threat model:
 * - Cursor strings are opaque to clients; they treat them as an
 *   unparseable token. The JSON inside is informational only — tampering
 *   with the date format or id type causes `decodeCursor` to throw.
 * - The decoded `id` is passed straight to Prisma, which uses parameterized
 *   queries, so SQL injection is not a concern. We still validate it is a
 *   non-empty string of bounded length so a tampered cursor can't smuggle
 *   a 10MB payload into the request handler.
 */

/**
 * Encode (date, id) as a base64url JSON cursor.
 *
 * @param {Date|string} date  UTC midnight Date from a @db.Date column, OR
 *                            a 'YYYY-MM-DD' string. Anything else throws.
 * @param {string}      id    Row id (non-empty string).
 * @returns {string} base64url-encoded JSON cursor.
 */
function encodeCursor(date, id) {
  const dateOnly = toDateOnlyString(date);
  if (typeof id !== 'string' || id.length === 0 || id.length > 128) {
    throw new InvalidCursorError('id must be a non-empty string (max 128 chars)');
  }
  const json = JSON.stringify({ date: dateOnly, id });
  return Buffer.from(json, 'utf8').toString('base64url');
}

/**
 * Decode a cursor produced by `encodeCursor`.
 *
 * Returns `{ date: Date, id: string }` where `date` is UTC midnight.
 * Throws `InvalidCursorError` on any malformed input (bad base64, bad
 * JSON, wrong field types, date not in YYYY-MM-DD, empty id).
 *
 * @param {string} cursor
 * @returns {{ date: Date, id: string }}
 */
function decodeCursor(cursor) {
  if (typeof cursor !== 'string' || cursor.length === 0) {
    throw new InvalidCursorError('cursor must be a non-empty string');
  }

  let raw;
  try {
    // base64url is a strict superset of standard base64 (it just replaces
    // +/= with -_ and omits padding). Buffer accepts both forms.
    raw = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw new InvalidCursorError('cursor is not valid base64');
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new InvalidCursorError('cursor is not valid JSON');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new InvalidCursorError('cursor JSON must be an object');
  }
  if (typeof parsed.date !== 'string') {
    throw new InvalidCursorError('cursor.date must be a string');
  }
  if (typeof parsed.id !== 'string' || parsed.id.length === 0 || parsed.id.length > 128) {
    throw new InvalidCursorError('cursor.id must be a non-empty string (max 128 chars)');
  }

  const date = parseDateOnly(parsed.date);
  if (!date) {
    throw new InvalidCursorError('cursor.date must be a valid YYYY-MM-DD date');
  }

  return { date, id: parsed.id };
}

/**
 * Sentinel error type for cursor decoding failures. Route handlers should
 * catch this and translate to `400 INVALID_CURSOR`.
 *
 * We don't extend `Error.prototype.name` via a custom constructor because
 * the only thing consumers need is to recognize it via `instanceof`.
 */
class InvalidCursorError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidCursorError';
    this.code = 'INVALID_CURSOR';
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

/**
 * Normalize a Date or YYYY-MM-DD string to YYYY-MM-DD.
 *
 * Accepts:
 *  - a JS Date (UTC midnight from a @db.Date column). We read UTC fields
 *    so a Date that "looks" like midnight in local time still serializes
 *    to the right calendar day.
 *  - a YYYY-MM-DD string.
 *
 * Anything else (full ISO timestamp, garbage) throws InvalidCursorError —
 * the contract is date-only on the wire.
 */
function toDateOnlyString(value) {
  if (value instanceof Date) {
    if (isNaN(value.getTime())) {
      throw new InvalidCursorError('date must be a valid Date');
    }
    const y = value.getUTCFullYear();
    const m = String(value.getUTCMonth() + 1).padStart(2, '0');
    const d = String(value.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  if (typeof value === 'string') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new InvalidCursorError('date must be YYYY-MM-DD');
    }
    if (!parseDateOnly(value)) {
      throw new InvalidCursorError('date is not a real calendar day (e.g. 2026-02-30)');
    }
    return value;
  }
  throw new InvalidCursorError('date must be a Date or YYYY-MM-DD string');
}

/**
 * Parse a strict YYYY-MM-DD string into a UTC midnight Date.
 *
 * Rejects:
 *  - anything not matching /^(\d{4})-(\d{2})-(\d{2})$/
 *  - month 0 or > 12, day 0 or > 31
 *  - dates that JS Date silently rolls over (e.g. 2026-02-30 → 2026-03-02)
 *
 * Returns a Date or null.
 */
function parseDateOnly(value) {
  if (typeof value !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const Y = +m[1];
  const M = +m[2];
  const D = +m[3];
  if (M < 1 || M > 12) return null;
  if (D < 1 || D > 31) return null;
  const dt = new Date(Date.UTC(Y, M - 1, D));
  if (dt.getUTCFullYear() !== Y || dt.getUTCMonth() !== M - 1 || dt.getUTCDate() !== D) {
    return null;
  }
  return dt;
}

module.exports = {
  encodeCursor,
  decodeCursor,
  InvalidCursorError,
  // exported for tests / reuse
  _parseDateOnly: parseDateOnly,
  _toDateOnlyString: toDateOnlyString,
};
