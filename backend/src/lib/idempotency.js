// Idempotency-Key replay cache — DR-012 / SOL audit umbrella.
//
// Round-10 introduced this on DPR to deduplicate POST retries (mobile blip,
// browser refresh, double-click) so the client gets the same response the
// server already committed. DR-012 found three write surfaces without it:
// inspection create, the employee digest, and the admin attendance digest.
//
// Scope of this module:
//   - in-process cache keyed by `${employeeId}:${idempotencyKey}`
//   - body-hash dedup so the same key with a DIFFERENT body returns
//     409 IDEMPOTENCY_MISMATCH (a security pin: a leaked key cannot be
//     used to probe arbitrary payloads against the cached slot)
//   - TTL-pruned (5 min) so the map cannot grow unboundedly
//
// Why in-process and not in Postgres:
//   - replays must be detected on the SAME request cycle that committed
//     the original response (so the client gets the cached row back
//     immediately). A DB lookup adds latency + a DB write on success,
//     which defeats the point on a hot path the client is already
//     retrying.
//   - replays within 5 min of the original are the realistic case
//     (mobile flap, browser refresh). Cross-restart replay protection
//     would need a Postgres unique constraint on (employeeId,
//     idempotencyKey, route), which is out of scope here.
//
// Usage:
//   const { tryReplay, recordSuccess } = require('../lib/idempotency');
//   router.post('/', (req, res) => {
//     const replay = tryReplay(req);
//     if (replay) return res.set('Idempotent-Replay', 'true').status(replay.status).json(replay.body);
//     // ... commit, then:
//     recordSuccess(req, status, body, req.body);
//   });

'use strict';

const crypto = require('crypto');

const IDEMPOTENCY_TTL_MS = 5 * 60 * 1000;
const MAX_KEY_LENGTH = 200;

// Process-local cache. One entry per (employeeId, idempotencyKey); body-hash
// included so a different body for the same key is rejected (security pin
// against replay attacks, see DR-006 history).
const cache = new Map(); // key: `${employeeId}:${idempotencyKey}` → { status, body, bodyHash, savedAt }

// Stable JSON stringify: sort object keys recursively so {a:1,b:2} and
// {b:2,a:1} produce identical output. Arrays preserve order. Matches
// dpr.js:184 exactly so the dpr replay slot and any future consumer
// share canonical semantics.
function canonicalJsonStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map((v) => canonicalJsonStringify(v)).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJsonStringify(value[k])).join(',') + '}';
}

function sha256Hex(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function prune() {
  const cutoff = Date.now() - IDEMPOTENCY_TTL_MS;
  for (const [k, v] of cache.entries()) {
    if (v.savedAt <= cutoff) cache.delete(k);
  }
}

// Extract the header (case-insensitive — Express normalizes headers to
// lowercase). Returns null when missing/invalid; callers MUST treat null
// as "no replay protection requested" and proceed normally.
function extractKey(req) {
  const raw = req.headers['idempotency-key'];
  if (!raw || typeof raw !== 'string') return null;
  if (raw.length === 0 || raw.length > MAX_KEY_LENGTH) return null;
  return raw;
}

function employeeIdOf(req) {
  return req.employeeId || req.user?.id || 'anonymous';
}

// Returns the cached entry on a valid replay (same employeeId + key +
// matching bodyHash), or null if no replay is warranted. A same-key
// different-body match returns { mismatch: true } so the caller can
// emit 409 IDEMPOTENCY_MISMATCH — a leaked key MUST NOT be allowed to
// probe arbitrary payloads against a cached slot (DR-006).
function tryReplay(req) {
  const key = extractKey(req);
  if (!key) return null;
  const bodyHash = sha256Hex(canonicalJsonStringify(req.body || {}));
  const cacheKey = `${employeeIdOf(req)}:${key}`;
  const cached = cache.get(cacheKey);
  if (!cached) return { key, bodyHash, miss: true };
  if (cached.bodyHash !== bodyHash) {
    return { key, bodyHash, mismatch: true, cached };
  }
  if (Date.now() - cached.savedAt > IDEMPOTENCY_TTL_MS) {
    cache.delete(cacheKey);
    return { key, bodyHash, miss: true };
  }
  return { key, bodyHash, replay: true, cached };
}

// Persist a successful response under the (employeeId, key) slot so a
// retry within the TTL window returns the cached body instead of
// re-running the side-effects.
function recordSuccess(req, status, body, requestBody) {
  const key = extractKey(req);
  if (!key) return;
  prune();
  const bodyHash = sha256Hex(canonicalJsonStringify(requestBody || {}));
  cache.set(`${employeeIdOf(req)}:${key}`, {
    status,
    body,
    bodyHash,
    savedAt: Date.now(),
  });
}

// Test-only escape hatch — Jest module reset otherwise leaves the
// module-level Map populated between cases. Production code must NOT
// call this; exported so __tests__ can clear state without reaching
// into module internals.
function _clearCache() {
  cache.clear();
}

module.exports = {
  tryReplay,
  recordSuccess,
  _clearCache,
  IDEMPOTENCY_TTL_MS,
  MAX_KEY_LENGTH,
  // Exported for unit tests that want to inspect canonical-json
  // behavior without going through the request lifecycle.
  canonicalJsonStringify,
  sha256Hex,
};
