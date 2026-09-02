const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { hashIdentifier } = require('../lib/pii');
const {
  ACCESS_TOKEN_TTL,
  recordRefreshToken,
  findRefreshTokenRow,
  claimRefreshToken,
  revokeAccessToken,
  revokeAllRefreshTokensForEmployee,
  revokeRefreshTokenByValue,
  rememberRotation,
  takeRotationReplay,
  pruneExpired,
} = require('../lib/revocation');

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
// Round-12: fall back to ALLOWED_ORIGINS/FRONTEND_URL before '*'. index.js
// already hard-fails at boot unless one of those is set in production, so
// in practice we now always post to an explicit origin and never broadcast
// tokens with a '*' targetOrigin.
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN
  || (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)[0]
  || process.env.FRONTEND_URL
  || '*';

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

// Email-domain allowlist for self-provisioning (Zoho-verified emails only).
// Adjust as needed; defaults to the customer domain + common test domains.
const ALLOWED_EMAIL_DOMAINS = (process.env.ALLOWED_EMAIL_DOMAINS
  ? process.env.ALLOWED_EMAIL_DOMAINS.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  : ['acschennai.com']
);

// Sign access (15m) and refresh (7d) tokens. Returns
// { accessToken, refreshToken, accessJti }.
//
// Round-20 (DR-005): the access token TTL dropped from 24h to 15m. The old
// 24h value was a workaround for expiry mid-upload, but it also meant a
// stolen token — or a stale `isAdmin` claim after a demotion — stayed usable
// for a full day. The frontend's auto-refresh interceptor (api.js) plus
// AuthContext's preemptive refresh now cover long sessions, and rotation
// below makes each refresh cheap and revocable.
//
// Access tokens carry a `jti` so logout can revoke them durably (see
// lib/revocation.js). Refresh tokens carry one too, purely to guarantee two
// refresh tokens minted in the same second for the same employee hash
// differently — `tokenHash` is UNIQUE, and without the jti a same-second
// re-issue could collide on the digest.
function signTokens(employee) {
  const accessJti = crypto.randomBytes(16).toString('base64url');
  const accessToken = jwt.sign(
    { employeeId: employee.id, email: employee.email, isAdmin: !!employee.isAdmin, jti: accessJti },
    JWT_SECRET,
    { algorithm: 'HS256', expiresIn: ACCESS_TOKEN_TTL }
  );
  const refreshToken = jwt.sign(
    { employeeId: employee.id, jti: crypto.randomBytes(16).toString('base64url') },
    JWT_REFRESH_SECRET,
    { algorithm: 'HS256', expiresIn: '7d' }
  );
  return { accessToken, refreshToken, accessJti };
}

// Mint a token pair AND persist the refresh token's digest, so the refresh
// endpoint can rotate it and logout can terminate it.
//
// Every path that hands a refresh token to a client must go through here.
// A refresh token with no `refresh_token` row is rejected at /refresh (see
// the REFRESH_UNKNOWN branch), so a call site that forgets this would hand
// out a session that dies at its first refresh.
async function issueSession(prisma, employee) {
  const tokens = signTokens(employee);
  await recordRefreshToken(prisma, {
    employeeId: employee.id,
    token: tokens.refreshToken,
  });
  return tokens;
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

// Render the OAuth popup's closing page.
//
// This is the ONLY route in this API that returns HTML containing an inline
// <script>, and it was failing on BOTH of the security headers helmet sets
// globally in index.js. Symptom in production: the popup rendered "Login
// successful! Please close this window.", never closed itself, and the
// portal login tab hung on "Signing in..." forever.
//
//  1. CSP. helmet 8's default policy is `script-src 'self'` with no
//     'unsafe-inline' and no nonce, so the browser refused to execute the
//     inline script at all — neither postMessage nor window.close() ever
//     ran, while the surrounding <p> still rendered. We mint a per-response
//     nonce and re-issue a *tighter* policy for this one response
//     (default-src 'none') rather than weakening the API-wide default.
//
//  2. COOP. helmet sets `same-origin-allow-popups` globally. That is the
//     correct value for an *opener*, but this document IS the popup and its
//     opener (the frontend origin) is cross-origin. Per the COOP matching
//     rule, policies match only if both are `unsafe-none`, or if they are
//     equal AND same-origin. Opener `unsafe-none` (GitHub Pages sets no
//     COOP) paired with `same-origin-allow-popups` here does NOT match, so
//     the popup is moved into a new browsing context group: window.opener
//     becomes null (the tokens are silently dropped) and the popup is no
//     longer an auxiliary browsing context, so window.close() is a no-op.
//     `unsafe-none` on this response keeps the popup in the opener's group.
//
// Cache-Control: no-store because the success body carries bearer tokens.
function sendPopupPage(res, { payload, message }) {
  const nonce = crypto.randomBytes(16).toString('base64');

  res.setHeader(
    'Content-Security-Policy',
    `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'`
  );
  res.setHeader('Cross-Origin-Opener-Policy', 'unsafe-none');
  res.setHeader('Cache-Control', 'no-store');

  // Escape sequences that could break out of the <script> context or the
  // JS string literal. The payload is server-built, but employee.name is
  // derived from user-controlled email, so don't rely on that staying true.
  const json = JSON.stringify(payload)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

  res.type('html').send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>ACS Chennai</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;display:flex;align-items:center;justify-content:center;height:100vh;color:#333;text-align:center;padding:1.5rem}</style>
</head><body><p id="m">${message}</p>
<script nonce="${nonce}">
(function () {
  var sent = false;
  try {
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage(${json}, ${JSON.stringify(FRONTEND_ORIGIN)});
      sent = true;
    }
  } catch (e) {}

  if (!sent) {
    document.getElementById('m').textContent =
      'Could not reach the portal tab. Please close this window and sign in again.';
    return;
  }

  window.close();
  // window.close() is silently ignored when the browser refuses (e.g. the
  // popup is not script-closable). Don't leave a stale "please close this
  // window" up if that happens — say what actually holds.
  setTimeout(function () {
    document.getElementById('m').textContent =
      'Signed in. You can close this window.';
  }, 500);
})();
</script></body></html>`);
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

  const errorHtml = (errorCode) => sendPopupPage(res, {
    payload: { type: 'zoho-oauth-error', error: errorCode },
    message: `Sign-in failed (${errorCode}). Closing...`,
  });

  if (!code) return errorHtml('no_code');

  // Round-9: TTL-enforced state check. consumeOAuthState both validates
  // expiresAt and one-time-uses the entry.
  if (!consumeOAuthState(state)) {
    return errorHtml('invalid_state');
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
      return errorHtml('token_exchange_failed');
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

    if (!email) return errorHtml('no_email');
    email = email.toLowerCase();

    // Email-domain allowlist (AppSec #20)
    const domain = email.split('@')[1];
    if (!domain || !ALLOWED_EMAIL_DOMAINS.includes(domain)) {
      console.warn('[zoho] signup blocked — domain not allowlisted', { emailHash: hashIdentifier(email), domain });
      return errorHtml('domain_not_allowed');
    }

    const prisma = req.app.get('prisma');

    const employee = await findOrCreateEmployee(prisma, {
      email,
      accessToken: access_token,
      refreshToken: refresh_token,
    });

    const { accessToken, refreshToken } = await issueSession(prisma, employee);

    sendPopupPage(res, {
      payload: {
        type: 'zoho-oauth-success',
        accessToken,
        refreshToken,
        employee: sanitizeEmployee(employee),
      },
      message: 'Signed in. Closing this window...',
    });
  } catch (err) {
    console.error('[zoho] callback error', err);
    errorHtml('server_error');
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

    const { accessToken, refreshToken } = await issueSession(prisma, employee);

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

  let tokens;
  try {
    tokens = await issueSession(prisma, employee);
  } catch (err) {
    // The refresh-token row is not optional: without it the session cannot be
    // rotated or revoked, so a partially-issued session is worse than a failed
    // login. Fail the login rather than hand back an unmanaged token pair.
    console.error('[login] session persist failed', err.message);
    return res.status(500).json({ error: 'Could not start session' });
  }

  res.json({
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    employee: sanitizeEmployee(employee),
  });
});

// POST /api/auth/refresh
//
// Round-20 (DR-005): refresh tokens are now STATEFUL and ROTATING.
//
// Before: a refresh token was a bare 7-day JWT. Nothing recorded it, so it
// could be replayed forever, survived logout, and a copy lifted from
// localStorage was worth a week of access. Now:
//
//   1. The presented token is looked up by sha256 digest.
//   2. An already-spent row means the token leaked — the legitimate client
//      discarded it at rotation, so whoever is presenting it now shouldn't
//      have it. Response: kill EVERY session for that employee (RFC 6819
//      §5.2.2.3 refresh-token replay detection) and 401.
//   3. Otherwise the row is atomically spent and a replacement is issued,
//      chained through `rotatedFromId`.
//
// The response now includes a NEW `refreshToken`. Clients MUST store it; the
// one they sent is dead the moment this returns 200. (src/lib/api.js and
// src/contexts/AuthContext.jsx were updated in the same commit.)
router.post('/refresh', async (req, res) => {
  const { refreshToken } = req.body || {};
  if (!refreshToken) return res.status(400).json({ error: 'Refresh token required' });

  const prisma = req.app.get('prisma');

  let decoded;
  try {
    decoded = jwt.verify(refreshToken, JWT_REFRESH_SECRET, { algorithms: ['HS256'] });
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Refresh token expired', code: 'REFRESH_EXPIRED' });
    }
    return res.status(401).json({ error: 'Invalid refresh token', code: 'REFRESH_INVALID' });
  }

  try {
    const row = await findRefreshTokenRow(prisma, refreshToken);

    // Signature is valid but we have no record of this token. Either it was
    // issued before DR-005 shipped (no rows existed yet) or its row was
    // pruned. We cannot rotate or revoke what we can't see, so refuse and make
    // the client re-authenticate. NOTE: this forces a one-time re-login for
    // every session that was live at deploy time — intentional, and the reason
    // the frontend already treats REFRESH_* codes as "bounce to login".
    if (!row) {
      return res.status(401).json({ error: 'Invalid refresh token', code: 'REFRESH_UNKNOWN' });
    }

    if (row.expiresAt.getTime() <= Date.now()) {
      return res.status(401).json({ error: 'Refresh token expired', code: 'REFRESH_EXPIRED' });
    }

    // Atomically spend the row. Losing this compare-and-swap means somebody
    // else already used this exact token.
    const won = await claimRefreshToken(prisma, row.id);

    if (!won) {
      // Benign case first: two tabs of the same browser share one refresh
      // token and raced. The winner's tokens are cached for a few seconds, so
      // hand the loser the same pair instead of nuking a healthy session.
      const replay = takeRotationReplay(row.id);
      if (replay) {
        return res.json(replay);
      }

      // No replay entry → this is a genuine replay of a long-spent token.
      // Treat as theft: revoke every live refresh token for the employee so
      // the attacker's chain dies along with the victim's.
      const killed = await revokeAllRefreshTokensForEmployee(prisma, row.employeeId, {
        reason: 'refresh_token_reuse',
      });
      console.warn('[refresh] token reuse detected — all sessions revoked', {
        employeeIdHash: hashIdentifier(row.employeeId),
        sessionsRevoked: killed,
      });
      return res.status(401).json({
        error: 'Refresh token already used — all sessions have been signed out',
        code: 'REFRESH_REUSED',
      });
    }

    // The employee must still exist (and we need their CURRENT isAdmin, not
    // the value baked into the token they logged in with).
    const employee = await prisma.employee.findUnique({
      where: { id: row.employeeId || decoded.employeeId },
      select: { id: true, email: true, isAdmin: true },
    });
    if (!employee) return res.status(401).json({ error: 'Employee not found' });

    const tokens = signTokens(employee);
    await recordRefreshToken(prisma, {
      employeeId: employee.id,
      token: tokens.refreshToken,
      rotatedFromId: row.id,
    });

    const payload = { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken };
    rememberRotation(row.id, payload);
    res.json(payload);
  } catch (err) {
    console.error('[refresh] error', err.message);
    // Do NOT collapse an infrastructure failure into 401: that would make the
    // frontend destroy a session that is actually still valid.
    res.status(503).json({ error: 'Could not refresh session', code: 'REFRESH_UNAVAILABLE' });
  }
});

// POST /api/auth/logout
//
// Round-20 (DR-005): actually ends the session, durably.
//
//   - the access token's `jti` goes into `revoked_token`, which requireAuth
//     checks on every request (the round-9 version wrote to an in-process Map
//     that no middleware ever read, so logout revoked precisely nothing);
//   - the presented refresh token's row is marked revoked, so it can't be
//     rotated into a fresh session afterwards.
//
// Idempotent, and always 204: a client that is signing out must never be left
// stuck because its token was already dead.
router.post('/logout', requireAuth, async (req, res) => {
  const prisma = req.app.get('prisma');
  const { refreshToken } = req.body || {};

  // requireAuth already verified the bearer token and stashed these.
  if (req.tokenJti) {
    try {
      await revokeAccessToken(prisma, {
        jti: req.tokenJti,
        employeeId: req.employeeId,
        expSeconds: req.tokenExp,
      });
    } catch (err) {
      console.error('[logout] access token revoke failed', err.message);
    }
  }

  try {
    if (refreshToken) {
      // Precise: kill only the session being signed out, leaving the user's
      // other devices alone.
      await revokeRefreshTokenByValue(prisma, refreshToken);
    } else {
      // No refresh token supplied (older cached frontend build, or a direct
      // API caller). We can't identify which row to kill, and leaving a live
      // 7-day token behind after an explicit sign-out is the DR-005 bug. Err
      // toward over-revoking: end all of this employee's sessions.
      await revokeAllRefreshTokensForEmployee(prisma, req.employeeId, {
        reason: 'logout_without_refresh_token',
      });
    }
  } catch (err) {
    console.error('[logout] refresh token revoke failed', err.message);
  }

  // Opportunistic prune of rows that can no longer deny anything. Done here
  // rather than on a setInterval so there's no timer to leak in tests or to
  // fire during shutdown. Failure is irrelevant to the caller.
  pruneExpired(prisma).catch(() => {});

  res.status(204).end();
});

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
