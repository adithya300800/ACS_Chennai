'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Durable token revocation — Round-20 / DR-005
// ─────────────────────────────────────────────────────────────────────────────
//
// WHAT WAS BROKEN
//
// Round-9 shipped a `tokenBlacklist` Map in routes/auth.js and a matching
// `isTokenRevoked()` helper... that no caller ever invoked. middleware/auth.js
// verified the JWT signature and called next(). Net effect: POST /logout was a
// no-op server-side. A bearer token copied out of localStorage stayed valid for
// the remaining 24h of its life, and the refresh token — a bare stateless JWT
// with no server-side record at all — stayed valid for a full 7 days. Signing
// out did not end a session; it only cleared the tab's localStorage.
//
// WHAT THIS MODULE DOES
//
//   1. Access tokens: logout writes the token's `jti` to `revoked_token`.
//      requireAuth consults that table on every authenticated request.
//   2. Refresh tokens: every issued refresh token now has a `refresh_token`
//      row (sha256 digest only). Refresh ROTATES — the presented row is spent
//      and a fresh one is issued, chained via `rotatedFromId`.
//   3. Reuse detection: presenting an already-spent refresh token means the
//      token leaked (it should have been discarded at rotation), so every
//      session for that employee is killed.
//
// State lives in Postgres via Prisma, so revocation survives the Render
// restart / redeploy that wiped the old in-process Map. Single-instance
// deployment today; when we scale out, the only piece that needs replacing is
// the read-through cache below (see MULTI-INSTANCE note on `revocationEvents`).

const crypto = require('crypto');
const { EventEmitter } = require('events');

// Access tokens are short-lived now (15m, down from 24h) — DR-005 item 4. The
// window during which a stale `isAdmin` claim or a not-yet-noticed stolen
// access token remains usable is bounded by this constant, so keep it small.
// Anything that must be enforced faster than this needs a live DB re-read
// (see requireFreshAdmin in middleware/auth.js).
const ACCESS_TOKEN_TTL = '15m';
const REFRESH_TOKEN_TTL_DAYS = 7;
const REFRESH_TOKEN_TTL_MS = REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000;

// Read-through cache sizing. The revocation lookup sits on the hot path of
// EVERY authenticated request, so an uncached design would add a round-trip to
// Postgres per API call. 60s TTL bounds staleness for entries we did not
// explicitly invalidate (i.e. revocations performed by another process); the
// logout path invalidates synchronously, so a single-instance deployment sees
// revocation take effect immediately, not in 60s.
const CACHE_MAX_ENTRIES = 2000;
const CACHE_TTL_MS = 60 * 1000;

// Rotation replay window. See takeRotationReplay() for the full rationale —
// without it, two browser tabs refreshing at the same instant look exactly
// like token theft and would log the user out everywhere.
const ROTATION_REPLAY_MS = 30 * 1000;

// ─────────────────────────────────────────────────────────────────────────────
// Cache invalidation bus
// ─────────────────────────────────────────────────────────────────────────────
// Emits:
//   'token:revoked'             { jti, employeeId }
//   'employee:sessions-revoked' { employeeId, count }
//
// The local cache invalidates by SUBSCRIBING to this emitter rather than by
// being poked directly, so the write paths (logout, reuse detection) don't need
// to know a cache exists.
//
// MULTI-INSTANCE: to run more than one Render instance, bridge this emitter to
// Redis pub/sub (publish on emit, re-emit locally on message). No other code
// changes — every consumer already goes through these events.
const revocationEvents = new EventEmitter();

// jti → { revoked: boolean, revokedAtMs: number|null, storedAt: number }
const revocationCache = new Map();

// Generation counter for the read-through race described in cachePut(). Bumped
// on every write that changes revocation state.
let cacheEpoch = 0;

function cacheEpochNow() {
  return cacheEpoch;
}

function cacheGet(jti) {
  const entry = revocationCache.get(jti);
  if (!entry) return null;
  if (Date.now() - entry.storedAt > CACHE_TTL_MS) {
    revocationCache.delete(jti);
    return null;
  }
  // LRU touch: re-insert so this key moves to the tail of the insertion order
  // that the eviction loop below consumes from the head.
  revocationCache.delete(jti);
  revocationCache.set(jti, entry);
  return entry;
}

// `epochAtRead` is the value of cacheEpoch captured BEFORE the DB read that
// produced `value`. If a revocation landed while that read was in flight the
// result is already stale, and caching it would paper over the revocation for
// a full CACHE_TTL_MS — the exact bug the cache must not introduce. In that
// case we drop the value and let the next request re-read.
function cachePut(jti, value, epochAtRead) {
  if (epochAtRead !== undefined && epochAtRead !== cacheEpoch) return;
  revocationCache.set(jti, { ...value, storedAt: Date.now() });
  while (revocationCache.size > CACHE_MAX_ENTRIES) {
    const oldest = revocationCache.keys().next();
    if (oldest.done) break;
    revocationCache.delete(oldest.value);
  }
}

function clearRevocationCache() {
  revocationCache.clear();
  cacheEpoch += 1;
}

// Cache maintenance is wired through the event bus (see comment on
// revocationEvents). A single revoked jti is cached POSITIVELY rather than
// merely evicted, so the next request from the just-logged-out client is
// rejected without touching the database.
revocationEvents.on('token:revoked', ({ jti, revokedAtMs }) => {
  cacheEpoch += 1;
  if (!jti) return;
  revocationCache.set(jti, {
    revoked: true,
    revokedAtMs: typeof revokedAtMs === 'number' ? revokedAtMs : Date.now(),
    storedAt: Date.now(),
  });
});

// A bulk employee-level revocation can't be mapped to individual jtis without
// a scan, so drop the whole cache. This fires only on logout-all / detected
// token theft — rare enough that the cold-cache cost is irrelevant.
revocationEvents.on('employee:sessions-revoked', () => {
  clearRevocationCache();
});

// ─────────────────────────────────────────────────────────────────────────────
// Hashing
// ─────────────────────────────────────────────────────────────────────────────

// Refresh tokens are stored as sha256 digests, never in the clear: a read-only
// leak of `refresh_token` (SQL injection, stray backup, an over-broad support
// query) must not yield usable 7-day credentials.
//
// sha256 without a per-row salt is deliberate and sufficient here — unlike a
// password, the input is a 300+ character JWT containing 128 bits of random
// `jti`, so it is not brute-forcible or rainbow-table-able. It also has to be
// a DETERMINISTIC digest: lookup is `WHERE token_hash = ?`, which bcrypt's
// per-row salt would make impossible without scanning every row.
function hashRefreshToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

// ─────────────────────────────────────────────────────────────────────────────
// Access-token revocation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Is this access token revoked?
 *
 * @param prisma  PrismaClient
 * @param decoded the VERIFIED jwt payload — must contain `jti`; `iat` optional
 * @returns Promise<boolean>
 * @throws  on database failure. Callers MUST NOT swallow this into a
 *          "not revoked" answer — see the fail-closed handling in requireAuth.
 */
async function isAccessTokenRevoked(prisma, decoded) {
  const jti = decoded && decoded.jti;

  // No jti → nothing to look up. Only tokens minted before round-9 lack one,
  // and every such token expired long ago (24h TTL). Treated as not-revoked
  // because a revocation record for them cannot exist by construction.
  if (!jti) return false;

  const cached = cacheGet(jti);
  const entry = cached || await (async () => {
    const epochAtRead = cacheEpochNow();
    const row = await prisma.revokedToken.findUnique({
      where: { jti },
      select: { revokedAt: true },
    });
    const value = row
      ? { revoked: true, revokedAtMs: row.revokedAt.getTime() }
      : { revoked: false, revokedAtMs: null };
    // Negative results are cached too — the overwhelmingly common case is a
    // live token, and without negative caching every request would hit the DB.
    cachePut(jti, value, epochAtRead);
    return value;
  })();

  if (!entry.revoked) return false;

  // DR-005 spec: reject only when the revocation happened AFTER the token was
  // issued. Guards the (astronomically unlikely, 128-bit) case of a jti
  // collision with an older revoked token — a fresh token must not inherit an
  // ancestor's revocation.
  //
  // A revoked row with an unusable `iat` is treated as REVOKED (fail closed):
  // we know the token was explicitly killed and have no evidence it postdates
  // that, so the safe reading is "denied".
  if (typeof decoded.iat !== 'number' || !Number.isFinite(decoded.iat)) return true;

  return entry.revokedAtMs > decoded.iat * 1000;
}

/**
 * Record an access token as revoked. Idempotent — logout is retryable and two
 * parallel logouts with the same bearer token must both succeed.
 *
 * @param expSeconds the token's `exp` claim (seconds), stored as `expiresAt`
 *        so pruneExpired() can drop the row once it can't deny anything.
 */
async function revokeAccessToken(prisma, { jti, employeeId, expSeconds }) {
  if (!jti) return null;

  const revokedAt = new Date();
  // Fall back to the max access-token lifetime if `exp` is missing, so the row
  // always has a prune horizon and can never become immortal.
  const expiresAt = Number.isFinite(expSeconds)
    ? new Date(expSeconds * 1000)
    : new Date(revokedAt.getTime() + 24 * 60 * 60 * 1000);

  const row = await prisma.revokedToken.upsert({
    where: { jti },
    // Keep the ORIGINAL revokedAt on a repeat logout: moving it later could
    // only ever revoke MORE tokens, and re-revoking is not new information.
    update: {},
    create: { jti, employeeId: employeeId || 'unknown', revokedAt, expiresAt },
  });

  revocationEvents.emit('token:revoked', {
    jti,
    employeeId,
    revokedAtMs: (row.revokedAt || revokedAt).getTime(),
  });
  return row;
}

// ─────────────────────────────────────────────────────────────────────────────
// Refresh-token lifecycle
// ─────────────────────────────────────────────────────────────────────────────

function refreshTokenExpiry(from = new Date()) {
  return new Date(from.getTime() + REFRESH_TOKEN_TTL_MS);
}

/**
 * Persist a newly issued refresh token. Called by every path that mints one
 * (password login, both Zoho callbacks, and rotation itself).
 */
function recordRefreshToken(prisma, { employeeId, token, rotatedFromId = null, expiresAt = null }) {
  return prisma.refreshToken.create({
    data: {
      employeeId,
      tokenHash: hashRefreshToken(token),
      rotatedFromId,
      expiresAt: expiresAt || refreshTokenExpiry(),
    },
  });
}

function findRefreshTokenRow(prisma, token) {
  return prisma.refreshToken.findUnique({ where: { tokenHash: hashRefreshToken(token) } });
}

/**
 * Atomically spend a refresh-token row: mark it revoked, but only if it was
 * still live.
 *
 * The `revokedAt: null` guard makes this a compare-and-swap, which is what
 * makes reuse detection race-free: if two requests present the same token
 * concurrently, exactly one updateMany reports count === 1 and the other gets
 * 0 and is handled as a replay. Doing this as read-then-write would let both
 * requests believe they were the legitimate holder.
 *
 * @returns Promise<boolean> true if THIS caller won the token.
 */
async function claimRefreshToken(prisma, rowId) {
  const now = new Date();
  const result = await prisma.refreshToken.updateMany({
    where: { id: rowId, revokedAt: null },
    data: { revokedAt: now, lastUsedAt: now },
  });
  return result.count === 1;
}

/**
 * Kill every live refresh token for an employee. Used by logout-without-token
 * and — critically — as the response to detected token reuse.
 */
async function revokeAllRefreshTokensForEmployee(prisma, employeeId, { reason = 'unspecified' } = {}) {
  const now = new Date();
  const result = await prisma.refreshToken.updateMany({
    where: { employeeId, revokedAt: null },
    data: { revokedAt: now },
  });
  revocationEvents.emit('employee:sessions-revoked', {
    employeeId,
    count: result.count,
    reason,
  });
  return result.count;
}

async function revokeRefreshTokenByValue(prisma, token) {
  const row = await findRefreshTokenRow(prisma, token);
  if (!row || row.revokedAt) return null;
  await claimRefreshToken(prisma, row.id);
  return row;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rotation replay window (multi-tab safety)
// ─────────────────────────────────────────────────────────────────────────────
//
// Rotation plus reuse detection has a well-known failure mode: two tabs of the
// same browser share one refresh token in localStorage. Both hit a 401 at the
// same moment, both POST /auth/refresh with the SAME token. One wins the
// compare-and-swap; the loser is presenting an already-spent token, which is
// indistinguishable from theft — so the naive implementation revokes every
// session and boots the user out of both tabs. With 15-minute access tokens
// this would fire many times a day, and this codebase has a documented history
// of exactly this complaint ("session expired ... multiple times", round-5).
//
// Fix: for ROTATION_REPLAY_MS after a successful rotation, remember the tokens
// we handed out, keyed by the spent row's id. A replay inside that window
// receives the SAME pair the winner got, so both tabs converge on one valid
// session instead of tripping the alarm. Outside the window — or for a token
// whose replay entry was already consumed by its rightful owner and has since
// expired — the presentation is treated as theft.
//
// The tokens sit in memory only, for 30 seconds, and are never written to disk
// or logs. That is a strictly smaller exposure than the client's localStorage.
const rotationReplay = new Map(); // spentRowId → { payload, storedAt }

function rememberRotation(spentRowId, payload) {
  if (!spentRowId) return;
  rotationReplay.set(spentRowId, { payload, storedAt: Date.now() });
  // Opportunistic sweep — the map only ever holds a few seconds of rotations.
  const cutoff = Date.now() - ROTATION_REPLAY_MS;
  for (const [key, entry] of rotationReplay.entries()) {
    if (entry.storedAt < cutoff) rotationReplay.delete(key);
  }
}

// Non-destructive read: a replay entry serves EVERY tab that raced, not just
// the first one to ask, so it stays until its TTL expires.
function takeRotationReplay(spentRowId) {
  const entry = rotationReplay.get(spentRowId);
  if (!entry) return null;
  if (Date.now() - entry.storedAt > ROTATION_REPLAY_MS) {
    rotationReplay.delete(spentRowId);
    return null;
  }
  return entry.payload;
}

function clearRotationReplay() {
  rotationReplay.clear();
}

// ─────────────────────────────────────────────────────────────────────────────
// Pruning
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Delete rows that can no longer deny anything (`expiresAt` in the past).
 * Both tables are indexed on `expiresAt` for exactly this scan.
 *
 * Called opportunistically from the logout path rather than on a timer, so
 * there is no interval to leak across test runs or graceful shutdown.
 */
async function pruneExpired(prisma, { now = new Date() } = {}) {
  const [revoked, refresh] = await Promise.all([
    prisma.revokedToken.deleteMany({ where: { expiresAt: { lt: now } } }),
    prisma.refreshToken.deleteMany({ where: { expiresAt: { lt: now } } }),
  ]);
  return { revokedTokens: revoked.count, refreshTokens: refresh.count };
}

module.exports = {
  ACCESS_TOKEN_TTL,
  REFRESH_TOKEN_TTL_DAYS,
  REFRESH_TOKEN_TTL_MS,
  ROTATION_REPLAY_MS,
  CACHE_TTL_MS,
  CACHE_MAX_ENTRIES,
  revocationEvents,
  hashRefreshToken,
  isAccessTokenRevoked,
  revokeAccessToken,
  recordRefreshToken,
  findRefreshTokenRow,
  claimRefreshToken,
  revokeAllRefreshTokensForEmployee,
  revokeRefreshTokenByValue,
  refreshTokenExpiry,
  rememberRotation,
  takeRotationReplay,
  clearRotationReplay,
  clearRevocationCache,
  pruneExpired,
};
