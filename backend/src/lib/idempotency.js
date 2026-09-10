// Idempotency-Key replay cache — DR-012 / SOL audit umbrella + DR-020.
//
// Round-10 introduced this on DPR to deduplicate POST retries (mobile blip,
// browser refresh, double-click) so the client gets the same response the
// server already committed. DR-012 added it to inspection. DR-020 moved the
// slot from process memory to a Postgres-backed `request_dedupe` table so:
//
//   1. The reservation is locked BEFORE side-effects, not cached AFTER.
//      Concurrent same-key, no-photo inspection requests can no longer
//      both create records — the second hits the PK collision at
//      reserve-time and gets 409. Same fix on billing COP, which had
//      no idempotency at all before this round.
//
//   2. The reservation survives a process restart. A crashed handler
//      that held the lock leaves a PENDING row that the janitor
//      can sweep after the lookup window expires. The legacy in-memory
//      Map forgot the lock the moment the process died, so a retry
//      after a restart happily created a duplicate.
//
// Two layers, kept in one file for the surface-area they share:
//
//   - Legacy in-memory cache: tryReplay / recordSuccess (round-10).
//     Still used by DPR. Same body-hash security pin. Backed by a
//     process-local Map keyed by `${employeeId}:${idempotencyKey}`.
//     Survives the 5-min TTL window only — restart forgets the slot.
//
//   - [DR-020] Durable DB-backed reservation: reserve / complete /
//     lookup / release. Namespaces the key as `${route}:${employeeId}:${rawKey}`
//     and locks the row in `request_dedupe` BEFORE the handler
//     commits. Lost-response retries + concurrent identical requests
//     yield ONE logical record + ONE notification handoff.
//
// Why both?
//   DPR's in-memory cache is a 5-min hot-path replay defence — kept
//   to avoid a DB write on every successful POST. Inspection / billing
//   use the durable path because the audit named them explicitly and
//   the DB write is one extra INSERT inside an already-tx handler
//   (cost: ~1ms). A future migration can flip DPR to durable too.
//
// Body-hash security pin (DR-006):
//   - Same key + same body → return cached response (replay).
//   - Same key + DIFFERENT body → 409 IDEMPOTENCY_MISMATCH. A leaked
//     key MUST NOT be allowed to probe arbitrary payloads against the
//     cached slot (DR-006 security history).
//
// Usage (legacy / DPR):
//   const { tryReplay, recordSuccess } = require('../lib/idempotency');
//   const replay = tryReplay(req);
//   if (replay && replay.mismatch) return res.status(409).json({...});
//   if (replay && replay.replay) return res.status(replay.cached.status).json(replay.cached.body);
//   // ... commit, then:
//   recordSuccess(req, status, body, req.body);
//
// Usage (DR-020 / billing / inspection):
//   const { reserve, complete, release } = require('../lib/idempotency');
//   const reservation = await reserve({ prisma, route: 'billing', req });
//   if (reservation.replay) return res.status(reservation.cached.status).json(reservation.cached.body);
//   if (reservation.conflict) return res.status(409).json({...});
//   // ... commit, then:
//   await complete({ prisma, reservation, status: 201, body: row, recordKind: 'billingCertification', recordId: row.id });
//   // On a handler error / retry-with-different-body, call release() to drop
//   // the PENDING lock so the client can fix and retry.

'use strict';

const crypto = require('crypto');

const IDEMPOTENCY_TTL_MS = 5 * 60 * 1000;
const MAX_KEY_LENGTH = 200;
// [DR-020] Reservation state strings — match the CHECK constraint in
// migration 20260909200000_dr020_request_dedupe/migration.sql.
const STATE_PENDING = 'PENDING';
const STATE_COMPLETED = 'COMPLETED';
const STATE_FAILED = 'FAILED';
// Pending slots are GC'd after this window (an actually-running handler
// completes well under 30s on the slow path; 5 min leaves headroom for
// a slow DB migration + cold-start). A restart that picks up a
// PENDING > PENDING_EVICT_MS slot treats it as a leaked reservation
// and lets the new request claim it.
const PENDING_EVICT_MS = 5 * 60 * 1000;
// COMPLETED slots are kept for this long — long enough for the
// realistic retry window (browser refresh within an hour) without
// letting the table grow unboundedly. Admin query can DELETE WHERE
// expires_at < now() to keep the table bounded.
const COMPLETED_TTL_MS = 60 * 60 * 1000;

// ─── Legacy in-memory cache (round-10) ──────────────────────────────────────
// Kept for DPR. New callers should use the DR-020 durable helpers.
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
// emit 409 IDEMPOTENCY_MISMATCH.
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

// ─── [DR-020] Durable DB-backed reservation helpers ────────────────────────
//
// Reserve the key BEFORE side-effects. Returns one of:
//   { key, bodyHash, fresh: true }           — reservation claimed,
//                                              caller proceeds with handler
//   { key, bodyHash, conflict: true }       — same key, PENDING reservation
//                                              held by another request — 409
//   { key, bodyHash, mismatch: true, cached } — same key, different body — 409
//   { key, bodyHash, replay: true, cached } — same key, same body, COMPLETED
//                                              — replay the cached response
//
// Graceful degradation: when `prisma.requestDedupe` is absent (the
// pre-migration deploy + the many unit suites that wire a hand-rolled
// Prisma mock), the helpers no-op to the legacy in-memory cache path.
// That keeps every existing test passing without forcing a global
// Prisma mock rewrite.
function namespaceKey({ route, employeeId, rawKey }) {
  // Namespaced key — `${route}:${employeeId}:${rawKey}`. The route +
  // employeeId prefix prevents cross-route and cross-user collisions
  // on the same client-chosen string.
  return `${route}:${employeeId || 'anon'}:${rawKey}`;
}

async function lookupReservation({ prisma, namespacedKey }) {
  if (!prisma || !prisma.requestDedupe) return null;
  return prisma.requestDedupe.findUnique({ where: { key: namespacedKey } });
}

async function reserve({ prisma, route, req, ttlMs = COMPLETED_TTL_MS }) {
  const rawKey = extractKey(req);
  if (!rawKey) {
    // No header → no reservation. Caller proceeds with the handler.
    // Backward-compatible with callers that never opted in.
    return { key: null, bodyHash: null, fresh: false, skipped: true };
  }
  const employeeId = employeeIdOf(req);
  const bodyHash = sha256Hex(canonicalJsonStringify(req.body || {}));
  const namespacedKey = namespaceKey({ route, employeeId, rawKey });

  // Legacy path: no DB → fall back to the in-memory cache so pre-migration
  // deployments keep working. The 5-min TTL still bounds the slot; the
  // audit's restart guarantee does NOT survive this branch, but that's
  // documented as a known gap in the migration header.
  if (!prisma || !prisma.requestDedupe) {
    const replay = tryReplay(req);
    if (replay && replay.replay) {
      return { key: rawKey, bodyHash, replay: true, cached: replay.cached, legacy: true, employeeId, body: req.body || {} };
    }
    if (replay && replay.mismatch) {
      return { key: rawKey, bodyHash, mismatch: true, cached: replay.cached, legacy: true, employeeId, body: req.body || {} };
    }
    return { key: rawKey, bodyHash, fresh: true, legacy: true, employeeId, body: req.body || {}, skipped: 'no-prisma-requestdedupe' };
  }

  // Fast path: try to claim the slot. The unique constraint on `key`
  // is the concurrency primitive — two concurrent reservations cannot
  // both succeed. The losing request catches P2002 below and re-reads
  // the row to distinguish PENDING (409 conflict) from COMPLETED (replay).
  try {
    await prisma.requestDedupe.create({
      data: {
        key: namespacedKey,
        payloadHash: bodyHash,
        state: STATE_PENDING,
      },
    });
    return {
      key: rawKey,
      namespacedKey,
      bodyHash,
      fresh: true,
    };
  } catch (err) {
    // P2002 = unique constraint violation = someone else holds the slot.
    // Read it back to figure out whether they're done (replay) or still
    // running (conflict) or already failed (mismatch? — see below).
    if (err && err.code !== 'P2002') throw err;
    const existing = await prisma.requestDedupe.findUnique({ where: { key: namespacedKey } });
    if (!existing) {
      // Vanishing row (someone hard-deleted between the failed insert
      // and the read). Re-attempt the reservation.
      try {
        await prisma.requestDedupe.create({
          data: { key: namespacedKey, payloadHash: bodyHash, state: STATE_PENDING },
        });
        return { key: rawKey, namespacedKey, bodyHash, fresh: true };
      } catch (err2) {
        // Lost a race with a third writer — surface as conflict so the
        // client retries with the same key.
        return { key: rawKey, bodyHash, conflict: true };
      }
    }

    // Body-hash mismatch — same key, different payload. Security pin:
    // never let a leaked key probe arbitrary bodies against the cached
    // slot (DR-006).
    if (existing.payloadHash !== bodyHash) {
      return { key: rawKey, bodyHash, mismatch: true, cached: existing };
    }

    // PENDING slot held by a concurrent or crashed handler. If the row
    // is older than PENDING_EVICT_MS, treat it as leaked and reclaim.
    if (existing.state === STATE_PENDING) {
      const ageMs = Date.now() - existing.createdAt.getTime();
      if (ageMs > PENDING_EVICT_MS) {
        // Update in place to PENDING with a new createdAt. If two
        // callers race this reclaim, the second loses the
        // P2002-and-update dance and gets `conflict: true` below.
        try {
          await prisma.requestDedupe.update({
            where: { key: namespacedKey, state: STATE_PENDING },
            data: { createdAt: new Date(), updatedAt: new Date() },
          });
          return { key: rawKey, namespacedKey, bodyHash, fresh: true, reclaimed: true };
        } catch (updateErr) {
          // Update lost the race — another caller reclaimed first.
          return { key: rawKey, bodyHash, conflict: true };
        }
      }
      return { key: rawKey, bodyHash, conflict: true };
    }

    // COMPLETED — return the cached response.
    if (existing.state === STATE_COMPLETED) {
      return {
        key: rawKey,
        bodyHash,
        replay: true,
        cached: { status: existing.resultStatus, body: existing.resultBody },
      };
    }

    // FAILED — slot is poisoned. A retry with the same body would loop,
    // so we reject as a conflict. Caller's path to recovery is to fix
    // the payload (different body → different key) or wait for the
    // janitor to GC the row.
    if (existing.state === STATE_FAILED) {
      return { key: rawKey, bodyHash, conflict: true, poisoned: true };
    }

    // Unknown state — treat as conflict so we don't accidentally
    // double-commit.
    return { key: rawKey, bodyHash, conflict: true };
  }
}

// Mark the reservation as COMPLETED with the response body. Called
// after the handler commits the row + the side-effects (admin
// fan-out, etc.) so a retry that races the handler completion
// either gets a replay (COMPLETED) or a conflict (still PENDING).
async function complete({ prisma, reservation, status, body, recordKind, recordId, ttlMs = COMPLETED_TTL_MS }) {
  // No reservation → nothing to commit. Backward-compat with callers
  // that never opted in (no Idempotency-Key header).
  if (!reservation || !reservation.key) return;
  // [DR-017] Legacy in-memory branch — the slot lives in a process-
  // local Map. Without this, a deployment without request_dedupe
  // reserves a key but never records the success, so every retry
  // re-runs the handler (the bug the audit flagged for the COP +
  // inspection routes). Map write cannot roll back, so callers MUST
  // invoke this AFTER committing the row (see boq.js / inspection.js).
  if (reservation.legacy) {
    recordSuccess({ headers: { 'idempotency-key': reservation.key }, employeeId: reservation.employeeId || 'anon' }, status, body, reservation.body);
    return;
  }
  if (!prisma || !prisma.requestDedupe) return;
  await prisma.requestDedupe.update({
    where: { key: reservation.namespacedKey },
    data: {
      state: STATE_COMPLETED,
      resultStatus: status,
      resultBody: body ?? null,
      recordKind: recordKind || null,
      recordId: recordId || null,
      expiresAt: new Date(Date.now() + ttlMs),
      updatedAt: new Date(),
    },
  });
}

// Mark the reservation as FAILED so a retry with the same body
// doesn't loop forever on a deterministic handler error. The slot is
// poisoned until the janitor GCs it (expires_at on FAILED is null —
// the janitor relies on the state_created_at index + the slot's age,
// same shape as the PENDING eviction). Use `release()` instead when
// the caller wants the client to be able to retry.
async function fail({ prisma, reservation }) {
  if (!reservation || !reservation.namespacedKey) return;
  if (!prisma || !prisma.requestDedupe) return;
  await prisma.requestDedupe.update({
    where: { key: reservation.namespacedKey },
    data: {
      state: STATE_FAILED,
      updatedAt: new Date(),
    },
  });
}

// Drop the PENDING reservation so the client can retry. Used by the
// handler's catch block when an error is recoverable (e.g. a 4xx the
// client should fix and resend). Without this, a 400 would leave the
// slot PENDING for 5 min, blocking same-key retries.
async function release({ prisma, reservation }) {
  if (!reservation || !reservation.namespacedKey) return;
  if (!prisma || !prisma.requestDedupe) return;
  // deleteMany so a no-op (already COMPLETED by a racing writer) is
  // a clean exit instead of throwing P2025.
  await prisma.requestDedupe.deleteMany({
    where: { key: reservation.namespacedKey, state: STATE_PENDING },
  });
}

module.exports = {
  // Legacy in-memory API (DPR + DR-012 inspection). Kept unchanged so
  // the round-10 unit tests + the DR-012 test suite pass without
  // modification.
  tryReplay,
  recordSuccess,
  _clearCache,
  // [DR-020] Durable reservation API. New callers (billing COP +
  // inspection, going forward) use these.
  reserve,
  complete,
  fail,
  release,
  // Exported for unit tests that want to inspect canonical-json
  // behavior without going through the request lifecycle.
  canonicalJsonStringify,
  sha256Hex,
  namespaceKey,
  // Constants — exported so tests + future callers can stay in sync.
  MAX_KEY_LENGTH,
  IDEMPOTENCY_TTL_MS,
  PENDING_EVICT_MS,
  COMPLETED_TTL_MS,
  STATE_PENDING,
  STATE_COMPLETED,
  STATE_FAILED,
};
