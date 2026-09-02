const jwt = require('jsonwebtoken');
const { isAccessTokenRevoked } = require('../lib/revocation');

const MIN_SECRET_LENGTH = 32; // 256 bits — protects against brute-force / low-entropy secrets

const getJwtSecret = () => {
  // SECURITY (round-7): require a real secret in EVERY environment. The previous
  // design returned a published string `'change-me-in-development-only-not-for-production'`
  // whenever NODE_ENV !== 'production'. A single misconfiguration (e.g.
  // 'Production' vs 'production') would silently downgrade to a public constant
  // and allow forged tokens. Now we throw if the env var is missing or short,
  // unconditionally. Local dev must set JWT_SECRET too — use .env.example.
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error(
      'JWT_SECRET environment variable must be set. ' +
      'Generate with: openssl rand -base64 64'
    );
  }
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `JWT_SECRET must be at least ${MIN_SECRET_LENGTH} characters (got ${secret.length}). ` +
      'Generate with: openssl rand -base64 64'
    );
  }
  return secret;
};

// Eagerly validate secret at module load — fail fast in production rather than
// at first request. Cache the secret so we don't repeat the length check per req.
let _secret;
function secret() {
  if (!_secret) _secret = getJwtSecret();
  return _secret;
}

// Module-load validation in ALL environments (no NODE_ENV escape hatch).
try {
  secret();
} catch (e) {
  // Log so local devs see the error in their terminal; re-throw so the process
  // crashes immediately rather than booting with a forged-token-friendly state.
  console.error('[auth.js] FATAL:', e.message);
  throw e;
}

/**
 * Authentication middleware — validates JWT and sets req.employeeId / req.email / req.isAdmin.
 * Pins HS256 to prevent alg-confusion attacks. Returns specific error codes so the
 * frontend can distinguish expired vs invalid vs not-yet-valid tokens.
 *
 * Round-20 (DR-005): a valid signature is no longer sufficient. Every request
 * also checks the token's `jti` against the durable `revoked_token` table, so
 * POST /api/auth/logout actually ends the session. Before this, logout wrote to
 * an in-process Map that nothing read — a token lifted from localStorage stayed
 * good for its full lifetime after sign-out. lib/revocation.js fronts that
 * lookup with a TTL cache, so the added cost is a Map hit for hot tokens.
 *
 * Deliberately NOT declared `async`: the JWT verify is synchronous and must stay
 * that way, and hand-rolling the promise chain keeps the "no DB wired" branch
 * (unit tests, health probes) fully synchronous while guaranteeing exactly one
 * terminal action — next() or a response — on every path.
 */
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authorization required' });
  }

  const token = authHeader.slice(7);

  let decoded;
  try {
    decoded = jwt.verify(token, secret(), {
      algorithms: ['HS256'],
    });
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
    }
    if (err.name === 'JsonWebTokenError') {
      return res.status(401).json({ error: 'Invalid token signature', code: 'TOKEN_INVALID' });
    }
    if (err.name === 'NotBeforeError') {
      return res.status(401).json({ error: 'Token not yet valid', code: 'TOKEN_NBF' });
    }
    return res.status(401).json({ error: 'Invalid or expired token', code: 'TOKEN_INVALID' });
  }

  req.employeeId = decoded.employeeId;
  req.email = decoded.email;
  req.isAdmin = decoded.isAdmin || false;
  req.tokenJti = decoded.jti;
  req.tokenExp = decoded.exp;

  const prisma = getPrisma(req);
  // No Prisma on the app (unit tests mounting this middleware standalone) —
  // signature verification is all we can do. Never reachable in the real app:
  // index.js sets `prisma` before any router is mounted.
  if (!prisma) return next();

  isAccessTokenRevoked(prisma, decoded)
    .then((revoked) => {
      if (revoked) {
        return res.status(401).json({ error: 'Token revoked', code: 'TOKEN_REVOKED' });
      }
      next();
    })
    .catch((err) => {
      // FAIL CLOSED. If we cannot prove the token is live, we do not let it
      // through — that would re-open DR-005 for the duration of any DB blip.
      //
      // 503 rather than 401 on purpose: the frontend interceptor treats 401 as
      // "session is dead", clears localStorage and bounces to /portal/login.
      // Destroying every user's session over a transient database error would
      // be a worse outage than the one we are already having. 503 surfaces as
      // a retryable error and leaves the session intact.
      console.error('[auth] revocation check failed', err && err.message);
      return res.status(503).json({
        error: 'Unable to verify session',
        code: 'REVOCATION_CHECK_FAILED',
      });
    });
}

/**
 * Admin-only middleware — must be used AFTER requireAuth.
 * Trusts the isAdmin claim from the JWT: cheap, but up to 15 minutes stale
 * (the access-token TTL). Fine for READ-ONLY admin queries.
 *
 * Anything that MUTATES must use requireFreshAdmin below instead.
 */
function requireAdmin(req, res, next) {
  if (!req.isAdmin) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

function getPrisma(req) {
  return req.app && typeof req.app.get === 'function' ? req.app.get('prisma') : null;
}

/**
 * Fresh-admin middleware — must be used AFTER requireAuth. Round-20 (DR-005).
 *
 * Re-reads `Employee.isAdmin` from the database instead of trusting the JWT
 * claim. Demoting someone from admin previously did nothing until their token
 * expired; they kept full approve/reject/assign powers for the rest of that
 * window. Now a demotion takes effect on their very next mutating request.
 *
 * Costs one indexed primary-key read per admin mutation — negligible next to
 * the writes these routes then perform, which is why read-only admin listing
 * endpoints stay on requireAdmin's cached claim.
 */
function requireFreshAdmin(req, res, next) {
  if (!req.employeeId) {
    return res.status(401).json({ error: 'Authorization required' });
  }

  const prisma = getPrisma(req);
  if (!prisma) {
    // Unlike requireAuth, there is no safe degraded mode here: the whole point
    // is that the JWT claim is not trustworthy for mutations.
    return res.status(503).json({ error: 'Unable to verify admin status', code: 'ADMIN_CHECK_FAILED' });
  }

  prisma.employee
    .findUnique({ where: { id: req.employeeId }, select: { id: true, isAdmin: true } })
    .then((employee) => {
      if (!employee) {
        // Token references an employee that no longer exists — 401, not 403:
        // the session itself is invalid, not merely under-privileged.
        return res.status(401).json({ error: 'Employee not found', code: 'EMPLOYEE_NOT_FOUND' });
      }
      // Overwrite the claim with ground truth so downstream handlers that also
      // branch on req.isAdmin cannot act on the stale value.
      req.isAdmin = !!employee.isAdmin;
      if (!req.isAdmin) {
        return res.status(403).json({ error: 'Admin access required', code: 'ADMIN_REQUIRED' });
      }
      next();
    })
    .catch((err) => {
      console.error('[auth] fresh admin check failed', err && err.message);
      return res.status(503).json({ error: 'Unable to verify admin status', code: 'ADMIN_CHECK_FAILED' });
    });
}

module.exports = { requireAuth, requireAdmin, requireFreshAdmin, getJwtSecret: secret };
