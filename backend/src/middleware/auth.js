const jwt = require('jsonwebtoken');

// Get JWT secret - fail fast in production
const getJwtSecret = () => {
  const secret = process.env.JWT_SECRET;
  if (process.env.NODE_ENV === 'production' && !secret) {
    throw new Error('JWT_SECRET environment variable must be set in production');
  }
  return secret || 'change-me-in-development';
};

/**
 * Authentication middleware - validates JWT token and sets req.employeeId
 */
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authorization required' });
  }

  const token = authHeader.slice(7);

  try {
    const decoded = jwt.verify(token, getJwtSecret());
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
 * Admin-only middleware - must be used after requireAuth
 */
function requireAdmin(req, res, next) {
  if (!req.isAdmin) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

module.exports = { requireAuth, requireAdmin, getJwtSecret };
