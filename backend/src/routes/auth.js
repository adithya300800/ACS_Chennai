const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { hashIdentifier } = require('../lib/pii');

// Fail fast if secrets are not set in production
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;

if (process.env.NODE_ENV === 'production') {
  if (!JWT_SECRET) throw new Error('JWT_SECRET environment variable must be set');
  if (!JWT_REFRESH_SECRET) throw new Error('JWT_REFRESH_SECRET environment variable must be set');
  if (JWT_SECRET.length < 32) throw new Error('JWT_SECRET must be >= 32 chars');
  if (JWT_REFRESH_SECRET.length < 32) throw new Error('JWT_REFRESH_SECRET must be >= 32 chars');
  if (JWT_SECRET === JWT_REFRESH_SECRET) throw new Error('JWT_SECRET and JWT_REFRESH_SECRET must differ');
}

// Zoho OAuth config
const ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID;
const ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
const ZOHO_REDIRECT_URI = process.env.ZOHO_REDIRECT_URI;
const ZOHO_DOMAIN = process.env.ZOHO_DOMAIN || 'https://accounts.zoho.com';

// Round-11: targetOrigin for the postMessage back to the popup opener.
//
// The popup is opened on the FRONTEND origin (acschennai.com) but the
// callback HTML runs on the BACKEND origin (acs-chennai.onrender.com),
// so `window.location.origin` here is the backend — wrong. Using the
// wrong target silently drops the postMessage and the parent never
// receives the OAuth tokens, leaving the user stuck on the login page
// even after Zoho says "Login successful".
//
// Set FRONTEND_ORIGIN to the deployed frontend origin (e.g.
// https://acschennai.com). When unset, fall back to '*'. This is still
// safe because the parent validates `event.origin` against
// VITE_API_URL on receipt (see src/pages/PortalLogin.jsx).
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || '*';

// OAuth state store: in-memory with TTL. NOTE: lost on restart — see P3 finding.
// For multi-instance deployments move to Redis.
//
// Round-9 hardening: every entry stores an explicit `expiresAt`. Both /zoho
// (write) and /zoho/callback (read) check that `now > expiresAt` and reject
// with a typed INVALID_STATE — previously the callback only checked
// `oauthStateStore.has(state)` which left the TTL unenforced and let an
// attacker replay a stolen state indefinitely until the prune pass on
// /zoho ran.
const oauthStateStore = new Map();
const STATE_TTL_MS = 5 * 60 * 1000; // 5 minutes — tightened from 10 in round-9

// Per-jti access-token blacklist for /api/auth/logout. Same TTL as the
// access token itself (24h). requireAuth() consults it on every request —
// keep the lookup cheap. NOTE: in-memory and per-process. For multi-instance
// deployments move to Redis. (Tracked as a known P3 limitation.)
const tokenBlacklist = new Map(); // jti → expiresAt (ms)

// Email-domain allowlist for self-provisioning (Zoho-verified emails only).
// Adjust as needed; defaults to the customer domain + common test domains.
const ALLOWED_EMAIL_DOMAINS = (process.env.ALLOWED_EMAIL_DOMAINS
  ? process.env.ALLOWED_EMAIL_DOMAINS.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  : ['acschennai.com']
);

// Sign access (24h) and refresh (7d) tokens. Returns { accessToken, refreshToken }.
// Access token is 24h so a single workday doesn't trigger expiry mid-upload. The
// real defence against expiry is the frontend's auto-refresh interceptor — once
// that's in place we can shorten this back to ~1h.
//
// Round-9: access tokens now carry a `jti` so the logout endpoint can revoke
// them via tokenBlacklist. We don't include jti on refresh tokens; logout
// clears the blacklist entry but the refresh token itself is JWT-only —
// full refresh-token revocation is out of scope for this round (P2).
function signTokens(employee) {
  const accessJti = crypto.randomBytes(16).toString('base64url');
  const accessToken = jwt.sign(
    { employeeId: employee.id, email: employee.email, isAdmin: !!employee.isAdmin, jti: accessJti },
    JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '24h' }
  );
  const refreshToken = jwt.sign(
    { employeeId: employee.id, jti: crypto.randomBytes(16).toString('base64url') },
    JWT_REFRESH_SECRET,
    { algorithm: 'HS256', expiresIn: '7d' }
  );
  return { accessToken, refreshToken, accessJti };
}

// Strip sensitive fields before returning employee to client.
// IMPORTANT: also strip zohoAccessToken / zohoRefreshToken (AppSec #11).
function sanitizeEmployee(employee) {
  const {
    password,
    zohoAccessToken,
    zohoRefreshToken,
    ...safe
  } = employee;
  return safe;
}

// Find or create an Employee by Zoho-verified email with a P2002-safe
// fallback. Two concurrent logins for the same Zoho user used to race on
// `prisma.employee.create` and surface P2002 as a 500 (P1-#9). The catch
// path re-fetches the row so the loser of the race continues down the
// "update tokens" branch instead of erroring out.
async function findOrCreateEmployee(prisma, { email, accessToken, refreshToken }) {
  let employee = await prisma.employee.findUnique({ where: { email } });
  if (employee) {
    return prisma.employee.update({
      where: { email },
      data: { zohoAccessToken: accessToken, zohoRefreshToken: refreshToken },
    });
  }
  const nameParts = email.split('@')[0].replace(/[._]/g, ' ').split(' ');
  const name = nameParts.map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join(' ');
  try {
    return await prisma.employee.create({
      data: { email, name, zohoAccessToken: accessToken, zohoRefreshToken: refreshToken },
    });
  } catch (err) {
    if (err && err.code === 'P2002') {
      // Lost the race; the winner created the row. Refetch and update.
      const existing = await prisma.employee.findUnique({ where: { email } });
      if (existing) {
        return prisma.employee.update({
          where: { email },
          data: { zohoAccessToken: accessToken, zohoRefreshToken: refreshToken },
        });
      }
    }
    throw err;
  }
}

// Validate OAuth state against the in-memory store. Returns the stored entry
// on success and consumes it (one-time use). Returns null on any failure so
// every call site can branch identically.
function consumeOAuthState(state) {
  if (!state || typeof state !== 'string') return null;
  const entry = oauthStateStore.get(state);
  if (!entry) return null;
  oauthStateStore.delete(state);
  if (!entry.expiresAt || Date.now() > entry.expiresAt) return null;
  return entry;
}

// POST /api/auth/zoho - Initiate Zoho OAuth. Frontend's PortalLogin.jsx
// calls POST (it has no body to send, but POST avoids the auth URL leaking
// through browser history and any CDN cache). Returns { authUrl } for the
// popup window to navigate to.
router.post('/zoho', (req, res) => {
  if (!ZOHO_CLIENT_ID || !ZOHO_REDIRECT_URI) {
    return res.status(503).json({ error: 'Zoho OAuth not configured' });
  }

  // Prune expired state entries (cheap; happens once per /zoho start).
  const now = Date.now();
  for (const [key, value] of oauthStateStore.entries()) {
    if (!value.expiresAt || now > value.expiresAt) {
      oauthStateStore.delete(key);
    }
  }

  // Cryptographically random state (AppSec #6) with an explicit expiresAt.
  const state = crypto.randomBytes(32).toString('base64url');
  oauthStateStore.set(state, { timestamp: now, expiresAt: now + STATE_TTL_MS });

  const scopes = 'openid profile email';
  const authUrl = `${ZOHO_DOMAIN}/oauth/v2/auth?` +
    `response_type=code&` +
    `client_id=${ZOHO_CLIENT_ID}&` +
    `redirect_uri=${encodeURIComponent(ZOHO_REDIRECT_URI)}&` +
    `scope=${encodeURIComponent(scopes)}&` +
    `state=${state}&` +
    `access_type=offline`;

  res.json({ authUrl });
});

// GET /api/auth/zoho/callback - Zoho redirects here with code (popup-window flow)
router.get('/zoho/callback', async (req, res) => {
  const { code, state } = req.query;

  const errorHtml = (errorCode) => `<!DOCTYPE html><html><body><script>
    if (window.opener) {
      window.opener.postMessage({ type: 'zoho-oauth-error', error: '${errorCode}' }, '${FRONTEND_ORIGIN}');
    }
    window.close();
  </script><p>Login failed (${errorCode}). Please close this window and try again.</p></body></html>`;

  if (!code) return res.send(errorHtml('no_code'));

  // Round-9: TTL-enforced state check. consumeOAuthState both validates
  // expiresAt and one-time-uses the entry.
  if (!consumeOAuthState(state)) {
    return res.send(errorHtml('invalid_state'));
  }

  try {
    const tokenRes = await fetch(`${ZOHO_DOMAIN}/oauth/v2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: ZOHO_CLIENT_ID,
        client_secret: ZOHO_CLIENT_SECRET,
        redirect_uri: ZOHO_REDIRECT_URI,
        code,
      }),
    });

    if (!tokenRes.ok) {
      console.error('[zoho] token exchange failed', tokenRes.status);
      return res.send(errorHtml('token_exchange_failed'));
    }

    const tokens = await tokenRes.json();
    const { access_token, refresh_token } = tokens;

    // Get email from id_token (openid scope guarantees this)
    let email = null;
    if (tokens.id_token) {
      try {
        const idTokenParts = tokens.id_token.split('.');
        const idPayload = JSON.parse(Buffer.from(idTokenParts[1], 'base64url').toString());
        email = idPayload.email;
      } catch (e) { /* fall through */ }
    }

    if (!email) return res.send(errorHtml('no_email'));
    email = email.toLowerCase();

    // Email-domain allowlist (AppSec #20)
    const domain = email.split('@')[1];
    if (!domain || !ALLOWED_EMAIL_DOMAINS.includes(domain)) {
      console.warn('[zoho] signup blocked — domain not allowlisted', { emailHash: hashIdentifier(email), domain });
      return res.send(errorHtml('domain_not_allowed'));
    }

    const prisma = req.app.get('prisma');

    const employee = await findOrCreateEmployee(prisma, {
      email,
      accessToken: access_token,
      refreshToken: refresh_token,
    });

    const { accessToken, refreshToken } = signTokens(employee);
    const employeeData = sanitizeEmployee(employee);

    const responseData = JSON.stringify({
      type: 'zoho-oauth-success',
      accessToken,
      refreshToken,
      employee: employeeData,
    });

    res.send(`<!DOCTYPE html><html><body><script>
      if (window.opener) {
        window.opener.postMessage(${responseData}, '${FRONTEND_ORIGIN}');
      }
      window.close();
    </script><p>Login successful! Please close this window.</p></body></html>`);
  } catch (err) {
    console.error('[zoho] callback error', err);
    res.send(errorHtml('server_error'));
  }
});

// POST /api/auth/zoho/callback - Same flow but for SPAs that handle the OAuth
// code themselves (no popup). REQUIRES state for CSRF protection (AppSec #5).
router.post('/zoho/callback', async (req, res) => {
  const { code, state } = req.body;

  if (!code) return res.status(400).json({ error: 'Authorization code required' });

  // Round-9: TTL-enforced state. Both missing/expired states collapse to a
  // single INVALID_STATE so an attacker can't distinguish "never issued" from
  // "expired".
  if (!consumeOAuthState(state)) {
    return res.status(400).json({ error: 'Invalid or missing OAuth state', code: 'INVALID_STATE' });
  }

  if (!ZOHO_CLIENT_ID || !ZOHO_CLIENT_SECRET || !ZOHO_REDIRECT_URI) {
    return res.status(503).json({ error: 'Zoho OAuth not configured' });
  }

  try {
    const tokenRes = await fetch(`${ZOHO_DOMAIN}/oauth/v2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: ZOHO_CLIENT_ID,
        client_secret: ZOHO_CLIENT_SECRET,
        redirect_uri: ZOHO_REDIRECT_URI,
        code,
      }),
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      console.error('[zoho] POST token exchange failed', tokenRes.status, errText.slice(0, 200));
      return res.status(401).json({ error: 'Failed to authenticate with Zoho' });
    }

    const tokens = await tokenRes.json();
    const { access_token, refresh_token } = tokens;

    // Email lookup — try the corrected Zoho Accounts userinfo endpoint first.
    let email = null;
    try {
      const userRes = await fetch(`${ZOHO_DOMAIN}/oauth/user/info`, {
        headers: { Authorization: `Zoho-oauthtoken ${access_token}` },
      });
      if (userRes.ok) {
        const data = await userRes.json();
        email = (data.Email || data.email || '').toLowerCase();
      }
    } catch (e) { /* fall through */ }

    if (!email && tokens.id_token) {
      try {
        const idTokenParts = tokens.id_token.split('.');
        const idPayload = JSON.parse(Buffer.from(idTokenParts[1], 'base64url').toString());
        email = (idPayload.email || '').toLowerCase();
      } catch (e) { /* fall through */ }
    }

    if (!email) {
      return res.status(400).json({ error: 'Could not determine email from Zoho. Please ensure your Zoho account has an email address.' });
    }

    const domain = email.split('@')[1];
    if (!domain || !ALLOWED_EMAIL_DOMAINS.includes(domain)) {
      console.warn('[zoho] POST signup blocked — domain not allowlisted', { emailHash: hashIdentifier(email), domain });
      return res.status(403).json({ error: 'Email domain not permitted' });
    }

    const prisma = req.app.get('prisma');

    const employee = await findOrCreateEmployee(prisma, {
      email,
      accessToken: access_token,
      refreshToken: refresh_token,
    });

    const { accessToken, refreshToken } = signTokens(employee);

    res.json({
      accessToken,
      refreshToken,
      employee: sanitizeEmployee(employee),
    });
  } catch (err) {
    console.error('[zoho] POST callback error', err);
    res.status(500).json({ error: 'Zoho authentication failed' });
  }
});

// POST /api/auth/login
// Password-based login ONLY for existing employees. NO auto-provisioning
// (AppSec #1). Auto-provisioning is reserved for the Zoho OAuth flow above,
// where the email is verified by Zoho.
//
// Round-9: the IP-only loginLimiter (mounted at /api/auth/login BEFORE
// body-parser in index.js) remains the first line of defence. A second
// IP+email-hash limiter (loginEmailLimiter) is mounted AFTER body-parser
// at the same path to defend against corporate-NAT credential stuffing.
router.post('/login', async (req, res) => {
  const prisma = req.app.get('prisma');
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const normalizedEmail = String(email).toLowerCase().trim();

  let employee;
  try {
    employee = await prisma.employee.findUnique({ where: { email: normalizedEmail } });
  } catch (err) {
    console.error('[login] DB error', err.message);
    return res.status(500).json({ error: 'Database error' });
  }

  // Use the same generic message whether the user doesn't exist OR the password
  // is wrong — prevents account enumeration via the login endpoint.
  const GENERIC_INVALID = { error: 'Invalid credentials' };

  if (!employee || !employee.password) {
    // Still hash a dummy password to balance timing roughly.
    await bcrypt.compare(password, '$2a$10$CwTycUXWue0Thq9StjUM0uJ8hZ4Pf0dXJ1q3hWXz9eP1qSfvCv4Rq').catch(() => {});
    return res.status(401).json(GENERIC_INVALID);
  }

  const valid = await bcrypt.compare(password, employee.password);
  if (!valid) return res.status(401).json(GENERIC_INVALID);

  const { accessToken, refreshToken } = signTokens(employee);
  res.json({
    accessToken,
    refreshToken,
    employee: sanitizeEmployee(employee),
  });
});

// POST /api/auth/refresh
// Pin HS256. Verify the employee still exists.
router.post('/refresh', async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(400).json({ error: 'Refresh token required' });

  try {
    const decoded = jwt.verify(refreshToken, JWT_REFRESH_SECRET, { algorithms: ['HS256'] });
    const prisma = req.app.get('prisma');

    const employee = await prisma.employee.findUnique({
      where: { id: decoded.employeeId },
      select: { id: true, email: true, isAdmin: true },
    });
    if (!employee) return res.status(401).json({ error: 'Employee not found' });

    const newJti = crypto.randomBytes(16).toString('base64url');
    const accessToken = jwt.sign(
      { employeeId: employee.id, email: employee.email, isAdmin: !!employee.isAdmin, jti: newJti },
      JWT_SECRET,
      { algorithm: 'HS256', expiresIn: '24h' }
    );
    res.json({ accessToken });
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Refresh token expired', code: 'REFRESH_EXPIRED' });
    }
    res.status(401).json({ error: 'Invalid refresh token', code: 'REFRESH_INVALID' });
  }
});

// POST /api/auth/logout
// Round-9: revokes the supplied access token via the in-memory blacklist.
// requireAuth consults tokenBlacklist on every request, so any further use
// of the same bearer token returns 401 TOKEN_REVOKED. Returns 204.
//
// Note: the refresh-token JWT itself is not on a deny-list (out of scope);
// for full revocation move to a tokenVersion column on Employee.
router.post('/logout', requireAuth, async (req, res) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
      if (decoded && decoded.jti && decoded.exp) {
        // exp is in seconds; convert to ms and store with a small grace so
        // a token already expired is harmlessly garbage-collected.
        tokenBlacklist.set(decoded.jti, decoded.exp * 1000);
      }
    } catch (e) {
      // Token already invalid — still return 204; logout is idempotent.
    }
  }
  // Opportunistic GC of expired blacklist entries so the Map can't grow
  // unbounded across long-running processes.
  const nowMs = Date.now();
  for (const [jti, exp] of tokenBlacklist.entries()) {
    if (exp <= nowMs) tokenBlacklist.delete(jti);
  }
  res.status(204).end();
});

// Helper exported for middleware/auth.js to consult the blacklist on every
// authenticated request. Returns true if the jti has been revoked.
function isTokenRevoked(jti) {
  if (!jti) return false;
  const exp = tokenBlacklist.get(jti);
  if (exp === undefined) return false;
  if (exp <= Date.now()) {
    tokenBlacklist.delete(jti);
    return false;
  }
  return true;
}

// GET /api/auth/me
// Round-9: returns the minimal { id, email, name, isAdmin } the frontend
// needs for preemptive refresh + UI gating. Extra fields (designation,
// department, createdAt) are dropped because the SPA already loads the
// richer profile from /api/employees/me-equivalents on the portal layout.
router.get('/me', requireAuth, async (req, res) => {
  const prisma = req.app.get('prisma');

  try {
    const employee = await prisma.employee.findUnique({
      where: { id: req.employeeId },
      select: { id: true, email: true, name: true, isAdmin: true },
    });

    if (!employee) return res.status(404).json({ error: 'Employee not found' });
    res.json(employee);
  } catch (err) {
    console.error('[me] error', err);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

module.exports = router;
module.exports.isTokenRevoked = isTokenRevoked;
