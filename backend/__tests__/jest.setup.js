// Jest setup file — runs before any test file is loaded.
// Required because src/middleware/auth.js and src/lib/pii.js now validate
// JWT_SECRET and PII_LOG_SALT at MODULE LOAD (fail-fast). Tests must seed
// these before any `require('src/...')` resolves.
//
// Set NODE_ENV=test so any NODE_ENV-specific branches take the test path.
// Use 64+ char test-only secrets; never reuse these in production.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret-must-be-at-least-32-chars-BBBB';
process.env.PII_LOG_SALT = process.env.PII_LOG_SALT || 'test-pii-salt-32-chars-min-deadbeef';
process.env.ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || 'http://localhost:3000';
process.env.FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/test';
