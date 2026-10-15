// [feat/google-login-allowlist] Parallel "Sign in with Google" route.
//
// Mirrors the Zoho flow structure (POST start -> GET/POST callback) but:
//   * The allowlist check is the gate: an allowlisted email is the only
//     path to a session. There is no self-service registration and no
//     domain-level open door.
//   * The ID token is verified with `jose` against Google's JWKS
//     (signature, audience, issuer) — full crypto verification, not
//     the "decode and trust" path that the existing Zoho code uses
//     (see LPR-011 in auth.js for the Zoho TODO; this round does NOT
//     bring Zoho to parity).
//   * Google's `sub` claim is persisted on first login and re-checked
//     on subsequent logins to defend against a Gmail address being
//     recycled after the original owner deletes it.
//   * The popup closing page is the same helper Zoho uses
//     (auth.sendPopupPage) — same `targetOrigin = FRONTEND_ORIGIN`
//     hardening, same `unsafe-none` COOP, same CSP nonce. The
//     frontend message listener at PortalLogin.jsx already validates
//     `event.origin` against `allowedOrigins`; the Google path
//     re-uses that listener with new message types
//     `google-oauth-success` / `google-oauth-error`.
//
// Denial-reason logging (amendment 11): the internal `reason`
// (`not_allowlisted` / `sub_mismatch` / `email_not_verified` /
// `token_invalid`) goes to the structured log via lib/log. The
// client always sees a single `GOOGLE_DENIED` error code — the
// reason is never included in the response, so a packet-sniffing
// attacker cannot distinguish the four modes.

const express = require('express');
const jose = require('jose');
const router = express.Router();

const {
  sendPopupPage,
  consumeOAuthState,
  oauthStateStore,
  STATE_TTL_MS,
  issueSession,
  sanitizeEmployee,
} = require('./auth');

const { findOrCreateEmployeeFromProvider } = require('../lib/userProvisioning');
const { googleStartLimiter, googleCallbackLimiter, googleSpaCallbackLimiter } = require('../middleware/rateLimit');
const log = require('../lib/log');
const { hashIdentifier } = require('../lib/pii');

// Google OAuth config. All four are required for the route to do
// anything useful; /active returns 404 unless they're all set so the
// frontend never offers a button that would 404 the user mid-flow.
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;
const GOOGLE_LOGIN_ENABLED = process.env.GOOGLE_LOGIN_ENABLED === 'true';

// Module-scoped JWKS. jose.createRemoteJWKSet handles caching +
// rotation per RFC 7517 (re-fetches JWKS on a kid miss, caches the
// validated key for the process lifetime). One instance is reused
// across every verify in the process — no per-request fetch.
//
// Pinned to jose v5 (the v6 line is ESM-only; backend is CommonJS).
// See package.json for the `^5.9.6` constraint.
const GOOGLE_JWKS = jose.createRemoteJWKSet(
  new URL('https://www.googleapis.com/oauth2/v3/certs')
);

// Both issuer values are accepted. Google has historically emitted
// both forms; the array form of `issuer` matches either.
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_SCOPES = 'openid email profile';

// Generic client-facing denial shape. Every denial path uses this
// exact JSON, with no internal reason leaked.
const GENERIC_DENIAL = Object.freeze({
  error: 'Access not enabled. Please contact your administrator.',
  code: 'GOOGLE_DENIED',
});

function isFullyConfigured() {
  return GOOGLE_LOGIN_ENABLED
    && !!GOOGLE_CLIENT_ID
    && !!GOOGLE_CLIENT_SECRET
    && !!GOOGLE_REDIRECT_URI;
}

// Log a denial with the specific internal reason + PII-redacted
// email hash. Tokens (id_token, access_token, refresh_token) are
// NEVER included — the structured log fields here are deliberately
// minimal so a future log leak cannot be used to forge sessions.
function logDenial(reason, { email, code, state } = {}) {
  log.warn('google_oauth_denied', {
    reason,
    emailHash: email ? hashIdentifier(email) : undefined,
    // state is also a secret in spirit (replay protection). We log
    // only the first 8 chars for cross-request correlation, never
    // the full value.
    statePrefix: state ? String(state).slice(0, 8) : undefined,
    code: code ? 'present' : 'missing',
  });
}

// GET /api/auth/google/active — drive the "Sign in with Google"
// button on the SPA. Returns { enabled: true } iff the env-var
// kill switch is on AND all three Google env vars are set;
// otherwise 404. Returning 404 (not 200 { enabled: false }) is
// deliberate: the frontend treats any non-200 as "do not render
// the button" so a misconfigured environment doesn't surface a
// broken UI.
router.get('/active', (req, res) => {
  if (!isFullyConfigured()) {
    return res.status(404).end();
  }
  res.json({ enabled: true });
});

// POST /api/auth/google — start the OAuth flow.
//
// Returns { authUrl } which the SPA navigates a popup to. The
// state token is a 256-bit cryptographically random string stored
// in the in-memory OAuth state store, tagged with flow: 'google'
// so a Zoho state cannot be replayed on the Google callback.
router.post('/', googleStartLimiter, (req, res) => {
  if (!isFullyConfigured()) {
    return res.status(404).json(GENERIC_DENIAL);
  }

  // Prune expired state entries (cheap; happens once per start).
  // Same shape as the Zoho prune in auth.js.
  const now = Date.now();
  for (const [key, value] of oauthStateStore.entries()) {
    if (!value.expiresAt || now > value.expiresAt) {
      oauthStateStore.delete(key);
    }
  }

  const state = require('crypto').randomBytes(32).toString('base64url');
  oauthStateStore.set(state, {
    timestamp: now,
    expiresAt: now + STATE_TTL_MS,
    flow: 'google',
  });

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT_URI,
    scope: GOOGLE_SCOPES,
    state,
    // prompt=select_account: force the Google account picker on every
    // login. Defends against the case where a shared browser already
    // has a different Google session cached.
    prompt: 'select_account',
  });
  res.json({ authUrl: `${GOOGLE_AUTH_URL}?${params.toString()}` });
});

// Exchange an authorization code for tokens (id_token + access_token).
// Standard Authorization Code flow per RFC 6749. We use fetch rather
// than a Google SDK to keep the dependency footprint small.
async function exchangeCodeForTokens(code) {
  const body = new URLSearchParams({
    code,
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    redirect_uri: GOOGLE_REDIRECT_URI,
    grant_type: 'authorization_code',
  });
  const resp = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`google token exchange failed: ${resp.status} ${text.slice(0, 200)}`);
  }
  return resp.json();
}

// Verify the id_token against Google's JWKS. Returns the verified
// claims. Throws on any failure (signature, audience, issuer,
// expiry). The reason is propagated to the caller so it can be
// logged; the client-facing response is generic.
async function verifyIdToken(idToken) {
  const { payload } = await jose.jwtVerify(idToken, GOOGLE_JWKS, {
    audience: GOOGLE_CLIENT_ID,
    issuer: GOOGLE_ISSUERS,
  });
  return payload;
}

// Look up the allowlist row for an email, check sub mismatch, then
// either reuse the linked Employee or look up / create a new one.
// Returns the Employee ready to be passed to issueSession.
async function provisionFromAllowlist(prisma, { allowlistRow, email, sub, name }) {
  // 1. Allowlist row must be active. (Inactive rows are filtered out
  //    at lookup time below, so reaching here implies active.)
  // 2. sub must match if the row already has one bound. First-login
  //    rows have googleSub = NULL — we stamp the incoming sub and
  //    move on.
  if (allowlistRow.googleSub && allowlistRow.googleSub !== sub) {
    logDenial('sub_mismatch', { email });
    const err = new Error('sub mismatch');
    err.denyReason = 'sub_mismatch';
    throw err;
  }

  // 3. Provision or reuse the Employee.
  let employee;
  if (allowlistRow.userId) {
    // The row was pre-linked (operator used `add --user <existing>`).
    // Reuse the existing Employee — do not look up by email because
    // a future Zoho user with the same email may now have a
    // different Employee id (path (b) in the plan).
    employee = await prisma.employee.findUnique({ where: { id: allowlistRow.userId } });
    if (!employee) {
      // The pre-linked Employee was deleted after the allowlist row
      // was created. Fall through to the email-match branch: if a
      // same-email Employee exists now, link it; otherwise create
      // a fresh one.
      employee = null;
    }
  }
  if (!employee) {
    employee = await findOrCreateEmployeeFromProvider(prisma, {
      email,
      displayName: name,
      extraFields: {},
    });
  }

  // 4. Stamp the allowlist row with sub + lastLoginAt + (if needed)
  //    the Employee link. Done AFTER provision so a provision
  //    failure doesn't leave the allowlist row mutated.
  const now = new Date();
  await prisma.googleLoginAllowlist.update({
    where: { id: allowlistRow.id },
    data: {
      googleSub: sub,
      lastLoginAt: now,
      userId: allowlistRow.userId || employee.id,
    },
  });

  return employee;
}

// Shared "run the OAuth flow" core, used by both GET and POST
// callbacks. `mode` is 'popup' (HTML closing page) or 'spa' (JSON).
async function runGoogleCallback(req, res, { code, state, mode }) {
  // 1. State must consume cleanly. The flow tag on the entry must
  //    be 'google' — a Zoho state fails here with INVALID_STATE.
  if (!consumeOAuthState(state, 'google')) {
    logDenial('invalid_state', { state });
    return mode === 'popup'
      ? sendPopupPage(res, { payload: { type: 'google-oauth-error', error: 'INVALID_STATE' }, message: 'Sign-in failed (INVALID_STATE). Closing...' })
      : res.status(400).json({ error: 'Invalid or expired state', code: 'INVALID_STATE' });
  }

  if (!code) {
    return mode === 'popup'
      ? sendPopupPage(res, { payload: { type: 'google-oauth-error', error: 'MISSING_CODE' }, message: 'Sign-in failed (MISSING_CODE). Closing...' })
      : res.status(400).json({ error: 'Missing code', code: 'MISSING_CODE' });
  }

  // 2. Exchange the code for tokens. We only consume the id_token —
  //    Google's access_token is unused (we mint our own JWT session)
  //    and we don't request a refresh_token (we mint our own).
  let tokens;
  try {
    tokens = await exchangeCodeForTokens(code);
  } catch (err) {
    logDenial('token_exchange_failed');
    log.error('google_token_exchange_error', { message: err && err.message });
    return mode === 'popup'
      ? sendPopupPage(res, { payload: { type: 'google-oauth-error', error: 'GOOGLE_DENIED' }, message: 'Sign-in failed. Closing...' })
      : res.status(403).json(GENERIC_DENIAL);
  }
  if (!tokens || !tokens.id_token) {
    logDenial('token_exchange_failed');
    return mode === 'popup'
      ? sendPopupPage(res, { payload: { type: 'google-oauth-error', error: 'GOOGLE_DENIED' }, message: 'Sign-in failed. Closing...' })
      : res.status(403).json(GENERIC_DENIED);
  }

  // 3. Verify the id_token (signature, audience, issuer, expiry).
  let claims;
  try {
    claims = await verifyIdToken(tokens.id_token);
  } catch (err) {
    logDenial('token_invalid');
    log.error('google_id_token_verify_failed', { message: err && err.message });
    return mode === 'popup'
      ? sendPopupPage(res, { payload: { type: 'google-oauth-error', error: 'GOOGLE_DENIED' }, message: 'Sign-in failed. Closing...' })
      : res.status(403).json(GENERIC_DENIAL);
  }

  // 4. Required claim checks.
  if (claims.email_verified !== true) {
    logDenial('email_not_verified');
    return mode === 'popup'
      ? sendPopupPage(res, { payload: { type: 'google-oauth-error', error: 'GOOGLE_DENIED' }, message: 'Sign-in failed. Closing...' })
      : res.status(403).json(GENERIC_DENIAL);
  }
  if (!claims.email || typeof claims.email !== 'string' || !claims.sub) {
    logDenial('token_invalid');
    return mode === 'popup'
      ? sendPopupPage(res, { payload: { type: 'google-oauth-error', error: 'GOOGLE_DENIED' }, message: 'Sign-in failed. Closing...' })
      : res.status(403).json(GENERIC_DENIAL);
  }
  // Lowercase the email before the allowlist lookup. Gmail is
  // case-insensitive on the local-part; a user who typed
  // "Test.User@Gmail.com" into their allowlist row should still
  // match an id_token that comes through as "test.user@gmail.com".
  // The CHECK constraint on the table guarantees the stored row is
  // already lowercase, so this normalization is the only canonical
  // form we work with.
  const email = String(claims.email).toLowerCase();
  const sub = String(claims.sub);
  const name = typeof claims.name === 'string' ? claims.name : null;

  // 5. Allowlist lookup. Inactive rows are NOT considered — an
  //    `add ... isActive=false` (or `remove`) means the user
  //    cannot sign in until an operator re-enables the row.
  const prisma = req.app.get('prisma');
  const allowlistRow = await prisma.googleLoginAllowlist.findFirst({
    where: { email, isActive: true },
  });
  if (!allowlistRow) {
    logDenial('not_allowlisted', { email });
    return mode === 'popup'
      ? sendPopupPage(res, { payload: { type: 'google-oauth-error', error: 'GOOGLE_DENIED' }, message: 'Sign-in failed. Closing...' })
      : res.status(403).json(GENERIC_DENIAL);
  }

  // 6. Provision / link. provisionFromAllowlist may throw a
  //    denyReason; we catch and map to the same generic shape.
  let employee;
  try {
    employee = await provisionFromAllowlist(prisma, { allowlistRow, email, sub, name });
  } catch (err) {
    if (err && err.denyReason) {
      // Already logged inside provisionFromAllowlist.
      return mode === 'popup'
        ? sendPopupPage(res, { payload: { type: 'google-oauth-error', error: 'GOOGLE_DENIED' }, message: 'Sign-in failed. Closing...' })
        : res.status(403).json(GENERIC_DENIAL);
    }
    throw err;
  }

  // 7. Issue the session. Same shape as the Zoho path so the
  //    frontend's setAuthData handler is provider-agnostic.
  const sessionTokens = await issueSession(prisma, employee);

  // 8. Respond. The popup path renders the postMessage closing
  //    page; the SPA path returns JSON. Both carry the same token
  //    pair + sanitized employee.
  const sanitized = sanitizeEmployee(employee);
  const payload = { type: 'google-oauth-success', ...sessionTokens, employee: sanitized };

  if (mode === 'popup') {
    return sendPopupPage(res, { payload, message: 'Login successful! You can close this window.' });
  }
  return res.json(payload);
}

// GET /api/auth/google/callback — popup flow. Google redirects the
// popup here with ?code=...&state=... in the query string.
router.get('/callback', googleCallbackLimiter, (req, res) => {
  // Kill switch: when Google is not fully configured, every route
  // (including the callbacks) returns 404. The plan mandates this:
  // "every route — including /active — returns 404" so the frontend
  // never offers a button that would 404 the user mid-flow. Without
  // this check, a callback request would still go through the
  // handler, find no matching state, and return an INVALID_STATE
  // popup — leaking the fact that the endpoint exists.
  if (!isFullyConfigured()) {
    return res.status(404).end();
  }
  return runGoogleCallback(req, res, {
    code: req.query.code,
    state: req.query.state,
    mode: 'popup',
  });
});

// POST /api/auth/google/callback — SPA flow. The SPA opens the
// Google auth URL in a same-tab navigation (not a popup) and
// POSTs the code back here. Returns JSON so the SPA can call
// setAuthData directly. IP-only rate limit (no email pre-parse —
// the email is inside the id_token, only known after verification).
router.post('/callback', googleSpaCallbackLimiter, (req, res) => {
  if (!isFullyConfigured()) {
    return res.status(404).end();
  }
  return runGoogleCallback(req, res, {
    code: req.body && req.body.code,
    state: req.body && req.body.state,
    mode: 'spa',
  });
});

module.exports = router;
