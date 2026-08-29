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

// OAuth state store: in-memory with TTL. NOTE: lost on restart — see P3 finding.
// For multi-instance deployments move to Redis.
const oauthStateStore = new Map();
const STATE_TTL_MS = 10 * 60 * 1000;
const STATE_TTL_SECONDS = STATE_TTL_MS / 1000;

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
function signTokens(employee) {
  const accessToken = jwt.sign(
    { employeeId: employee.id, email: employee.email, isAdmin: !!employee.isAdmin },
    JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '24h' }
  );
  const refreshToken = jwt.sign(
    { employeeId: employee.id },
    JWT_REFRESH_SECRET,
    { algorithm: 'HS256', expiresIn: '7d' }
  );
  return { accessToken, refreshToken };
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
    if (now - value.timestamp > STATE_TTL_MS) {
      oauthStateStore.delete(key);
    }
  }

  // Cryptographically random state (AppSec #6)
  const state = crypto.randomBytes(32).toString('base64url');
  oauthStateStore.set(state, { timestamp: now });

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
      window.opener.postMessage({ type: 'zoho-oauth-error', error: '${errorCode}' }, window.location.origin);
    }
    window.close();
  </script><p>Login failed (${errorCode}). Please close this window and try again.</p></body></html>`;

  if (!code) return res.send(errorHtml('no_code'));

  // Validate state for CSRF protection
  if (!state || !oauthStateStore.has(state)) {
    return res.send(errorHtml('invalid_state'));
  }
  oauthStateStore.delete(state); // one-time use

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

    // Find or create employee (Zoho-verified emails only)
    let employee = await prisma.employee.findUnique({ where: { email } });
    if (!employee) {
      const nameParts = email.split('@')[0].replace(/[._]/g, ' ').split(' ');
      const name = nameParts.map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join(' ');
      employee = await prisma.employee.create({
        data: {
          email,
          name,
          zohoAccessToken: access_token,
          zohoRefreshToken: refresh_token,
        },
      });
      console.log('[zoho] new employee provisioned', { employeeId: employee.id, emailHash: hashIdentifier(email) });
    } else {
      employee = await prisma.employee.update({
        where: { email },
        data: {
          zohoAccessToken: access_token,
          zohoRefreshToken: refresh_token,
        },
      });
    }

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
        window.opener.postMessage(${responseData}, window.location.origin);
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

  if (!state || !oauthStateStore.has(state)) {
    return res.status(400).json({ error: 'Invalid or missing OAuth state', code: 'INVALID_STATE' });
  }
  oauthStateStore.delete(state); // one-time use

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

    let employee = await prisma.employee.findUnique({ where: { email } });
    if (!employee) {
      const nameParts = email.split('@')[0].replace(/[._]/g, ' ').split(' ');
      const name = nameParts.map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join(' ');
      employee = await prisma.employee.create({
        data: {
          email,
          name,
          zohoAccessToken: access_token,
          zohoRefreshToken: refresh_token,
        },
      });
      console.log('[zoho] new employee provisioned (POST flow)', { employeeId: employee.id, emailHash: hashIdentifier(email) });
    } else {
      employee = await prisma.employee.update({
        where: { email },
        data: {
          zohoAccessToken: access_token,
          zohoRefreshToken: refresh_token,
        },
      });
    }

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

    const accessToken = jwt.sign(
      { employeeId: employee.id, email: employee.email, isAdmin: !!employee.isAdmin },
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

// GET /api/auth/me
router.get('/me', requireAuth, async (req, res) => {
  const prisma = req.app.get('prisma');

  try {
    const employee = await prisma.employee.findUnique({
      where: { id: req.employeeId },
      select: {
        id: true,
        email: true,
        name: true,
        designation: true,
        department: true,
        isAdmin: true,
        createdAt: true,
      },
    });

    if (!employee) return res.status(404).json({ error: 'Employee not found' });
    res.json(employee);
  } catch (err) {
    console.error('[me] error', err);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

module.exports = router;
