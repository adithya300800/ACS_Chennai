/**
 * Map Prisma errors to HTTP responses. The legacy catch-all returned 500 for
 * every error except P2002, which meant foreign-key violations (P2003),
 * validation errors (P2009), and DB-unreachable errors (P1001, P1017) all
 * looked like generic server bugs — masking real client errors as 500s
 * (Code Reviewer P1-1).
 *
 * Use:
 *   const mapped = mapPrismaError(err);
 *   if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
 *   // fall through to 500
 */

function mapPrismaError(err) {
  if (!err || typeof err.code !== 'string') return null;

  switch (err.code) {
    case 'P2002': {
      // Unique constraint failed. Surface the field if Prisma provided one
      // (it's in err.meta.target).
      const target = Array.isArray(err.meta?.target) ? err.meta.target.join(',') : (err.meta?.target || 'field');
      return {
        status: 409,
        code: 'DUPLICATE',
        message: `Duplicate value for ${target}`,
      };
    }
    case 'P2003':
      // FK constraint failed — e.g. submittedById points to a non-existent employee
      return { status: 400, code: 'FK_VIOLATION', message: 'Referenced record does not exist' };
    case 'P2009':
      // Prisma validation failed at query level — usually Invalid Date or type mismatch
      return { status: 400, code: 'VALIDATION_FAILED', message: 'Database rejected the input' };
    case 'P2025':
      // Record not found (update/delete where)
      return { status: 404, code: 'NOT_FOUND', message: 'Record not found' };
    case 'P2027':
      // Multiple errors occurred (transaction)
      return { status: 500, code: 'MULTIPLE_ERRORS', message: 'Transaction failed' };
    case 'P1001':
    case 'P1002':
    case 'P1017':
    case 'P2024':
      // DB connection issues — let the load balancer know to back off
      return { status: 503, code: 'DB_UNAVAILABLE', message: 'Database temporarily unavailable' };
    default:
      return null;
  }
}

/**
 * Wrap an async handler so Prisma errors are auto-mapped before the generic
 * catch returns 500. Use as: `safeHandler(async (req, res) => { ... })`
 */
function safeHandler(fn) {
  return async (req, res, next) => {
    try {
      await fn(req, res, next);
    } catch (err) {
      const mapped = mapPrismaError(err);
      if (mapped) {
        // Include the request id so the caller can correlate with server logs
        const requestId = res.getHeader('X-Request-Id') || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        res.setHeader('X-Request-Id', requestId);
        return res.status(mapped.status).json({
          error: mapped.message,
          code: mapped.code,
          requestId,
        });
      }
      next(err);
    }
  };
}

/**
 * Strict ISO date validator. Accepts "YYYY-MM-DD" only. Rejects:
 * - empty / non-string / null
 * - anything not matching /^(\d{4})-(\d{2})-(\d{2})$/
 * - month 0 or > 12
 * - day 0 or > 31
 * - dates that JS Date silently rolls over (e.g. 2026-02-30 → 2026-03-02)
 *
 * Returns { ok: true, date: Date } or { ok: false, error: 'INVALID_DATE' }.
 *
 * Code Reviewer P0-4 / P2-4.
 */
function parseStrictISODate(value) {
  if (typeof value !== 'string') return { ok: false, error: 'INVALID_DATE' };
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return { ok: false, error: 'INVALID_DATE' };
  const Y = +m[1];
  const M = +m[2];
  const D = +m[3];
  if (M < 1 || M > 12) return { ok: false, error: 'INVALID_DATE' };
  if (D < 1 || D > 31) return { ok: false, error: 'INVALID_DATE' };
  const dt = new Date(Date.UTC(Y, M - 1, D));
  // Catches silent rollover: 2026-02-30 would become 2026-03-02
  if (dt.getUTCFullYear() !== Y || dt.getUTCMonth() !== M - 1 || dt.getUTCDate() !== D) {
    return { ok: false, error: 'INVALID_DATE' };
  }
  return { ok: true, date: dt };
}

/**
 * Parse an ISO 8601 datetime string into a Date, returning null if invalid.
 * Lenient by design — accepts any valid Date constructor input but
 * rejects "Invalid Date" results.
 */
function parseISODateTime(value) {
  if (value == null) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Render a Date (typically from a Postgres `@db.Date` column) as a strict
 * YYYY-MM-DD string in UTC. SOL DR-004: the GET /dpr/:id endpoint was
 * emitting the raw `Date.toJSON()` form ("2026-09-01T00:00:00.000Z"),
 * which the frontend's `<input type="date">` rejected as malformed. The
 * matching PUT validator already accepts only `YYYY-MM-DD` — pin the GET
 * shape so the round-trip is consistent.
 *
 * Returns `null` for null/undefined/invalid input so callers can
 * straightforwardly pass through nullable DB columns.
 */
function toDateOnly(value) {
  if (value == null) return null;
  if (value instanceof Date) {
    if (isNaN(value.getTime())) return null;
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === 'string') {
    // Accept anything already YYYY-MM-DD prefixed (e.g. already serialized).
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    return null;
  }
  return null;
}

module.exports = { mapPrismaError, safeHandler, parseStrictISODate, parseISODateTime, toDateOnly };
