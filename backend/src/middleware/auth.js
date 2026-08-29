const jwt = require('jsonwebtoken');

const MIN_SECRET_LENGTH = 32; // 256 bits — protects against brute-force / low-entropy secrets

const getJwtSecret = () => {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('JWT_SECRET environment variable must be set');
    }
    return 'change-me-in-development-only-not-for-production';
  }
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`JWT_SECRET must be at least ${MIN_SECRET_LENGTH} characters (got ${secret.length}). Generate with: openssl rand -base64 64`);
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

// Module-load validation in production
if (process.env.NODE_ENV === 'production') {
  try {
    secret();
  } catch (e) {
    console.error('[auth.js] FATAL:', e.message);
    throw e;
  }
}

/**
 * Authentication middleware — validates JWT and sets req.employeeId / req.email / req.isAdmin.
 * Pins HS256 to prevent alg-confusion attacks. Returns specific error codes so the
 * frontend can distinguish expired vs invalid vs not-yet-valid tokens.
 */
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authorization required' });
  }

  const token = authHeader.slice(7);

  try {
    const decoded = jwt.verify(token, secret(), {
      algorithms: ['HS256'],
    });
    req.employeeId = decoded.employeeId;
    req.email = decoded.email;
    req.isAdmin = decoded.isAdmin || false;
    next();
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
}

/**
 * Admin-only middleware — must be used AFTER requireAuth.
 * Trusts the isAdmin claim from the JWT. Admin status changes take effect on
 * next JWT refresh (up to 8h). For immediate revocation, bump a tokenVersion
 * column on Employee and check it here.
 */
function requireAdmin(req, res, next) {
  if (!req.isAdmin) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

module.exports = { requireAuth, requireAdmin, getJwtSecret: secret };
