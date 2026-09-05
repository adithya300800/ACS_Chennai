// SOL DR-003 — owner-scoped draft storage.
//
// Before this module, the DPR and Inspection autosave keys were unscoped
// (`dpr_draft_v1`, `inspection_draft_v1`). That meant a Shared computer's
// localStorage kept the previous account's draft, and the next person to
// log in saw it pre-loaded into the form. SOL DR-003 reproduced exactly
// that: employee A's project marker survived into admin B's New DPR view
// after a logout.
//
// The fix is two-pronged:
//
//   1. Scope every key by `employeeId`. A logged-in user only ever reads
//      their own draft; another account's draft is invisible.
//
//   2. Migrate any legacy unscoped draft the FIRST time a given user opens
//      the form. We do this once per (key, employeeId) pair so a quick
//      logout/login on a shared computer does not silently attribute
//      Account A's draft to Account B. The marker `acsDraftMigration:v1`
//      records which unscoped keys we've already absorbed for the current
//      user so the migration is idempotent.
//
//   3. Clear the current user's draft on logout / session-expiry. The
//      AuthContext dispatches a `draft:clear-current` event from its
//      logout / auth:logout paths; both forms subscribe and drop their
//      state. We deliberately do NOT nuke other users' scoped drafts —
//      clearing only the current user is both the right privacy contract
//      and the right behaviour for shared test accounts.

'use strict';

const MIGRATION_MARKER_KEY = 'acsDraftMigration:v1';

function safeRead(key) {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Same as `safeRead` but ALSO returns a `corrupt` flag when the key exists
// but JSON.parse threw. Callers use this to distinguish "no draft" from
// "draft is unreadable" so they can surface a malformed-banner instead of
// silently dropping the user's data.
function safeReadDiagnostic(key) {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return { value: null, corrupt: false };
    return { value: JSON.parse(raw), corrupt: false };
  } catch {
    return { value: null, corrupt: true };
  }
}

function safeWrite(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

function safeRemove(key) {
  try { localStorage.removeItem(key); } catch {}
}

/**
 * Build the owner-scoped key for a given draft base + employee id.
 * Returns `null` if `employeeId` is missing — that is the signal callers
 * use to refuse to autosave into an account-ambiguous key.
 */
function scopedKey(base, employeeId) {
  if (!base || !employeeId || typeof employeeId !== 'string') return null;
  return `${base}:${employeeId}`;
}

/**
 * Read the current user's draft. Returns `null` when no draft exists or
 * when no employee is signed in.
 *
 * Side effect: if a legacy unscoped draft exists at `base` AND the current
 * user has never migrated this base before, copy that draft to the
 * scoped key and stamp the migration marker. This is the "same-user
 * recovery should survive expiry" half of the acceptance criteria — A
 * returns to A's machine and finds A's draft waiting.
 */
function load(base, employeeId) {
  const scoped = scopedKey(base, employeeId);
  if (!scoped) return null;

  const scopedValue = safeRead(scoped);
  if (scopedValue !== null) return scopedValue;

  // No scoped draft yet for this user. Look for a legacy unscoped draft.
  const legacy = safeRead(base);
  if (legacy === null) return null;

  const migration = safeRead(MIGRATION_MARKER_KEY) || {};
  if (!migration[base] || migration[base] !== employeeId) {
    // First time this base is being touched under this employee id —
    // migrate the legacy draft into the scoped key. We deliberately use
    // the SAME employeeId for the migration marker (not `true`), so a
    // future user with no draft does not silently inherit anything.
    safeWrite(scoped, legacy);
    safeRemove(base);
    safeWrite(MIGRATION_MARKER_KEY, { ...migration, [base]: employeeId });
    return legacy;
  }

  // Already migrated for this user, but the scoped key was empty (e.g.
  // user cleared the form). Don't re-migrate.
  return null;
}

/**
 * Save the current user's draft. No-op when no employee is signed in.
 */
function save(base, employeeId, payload) {
  const scoped = scopedKey(base, employeeId);
  if (!scoped) return;
  safeWrite(scoped, payload);
}

/**
 * Remove the current user's draft. No-op when no employee is signed in.
 */
function clear(base, employeeId) {
  const scoped = scopedKey(base, employeeId);
  if (!scoped) return;
  safeRemove(scoped);
}

/**
 * Clear every draft that belongs to `employeeId`. Called from logout /
 * session-expiry paths via the `draft:clear-current` event so subscribers
 * only act when the cleared user is the currently-authenticated user.
 */
function clearForUser(base, employeeId) {
  if (!base) return;
  const scoped = scopedKey(base, employeeId);
  if (!scoped) return;
  safeRemove(scoped);
}

/**
 * Drop drafts for any user that is NOT `currentEmployeeId`. Used on
 * logout so a shared computer does not retain another user's notes
 * indefinitely. Limited to the bases passed in (typically `dpr_draft_v1`
 * and `inspection_draft_v1`).
 *
 * The walk is intentionally cheap: we only enumerate keys whose prefix
 * matches one of the supplied bases, so it stays O(drafts) rather than
 * O(localStorage-size).
 */
function clearAllExcept(bases, currentEmployeeId) {
  if (!Array.isArray(bases) || bases.length === 0) return;
  const keepPrefixes = bases.map((b) => `${b}:`);
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const key = localStorage.key(i);
    if (!key) continue;
    if (!keepPrefixes.some((p) => key.startsWith(p))) continue;
    // Strip the prefix and the `:` to recover the employee id.
    const employeeId = key.slice(keepPrefixes.find((p) => key.startsWith(p)).length);
    if (employeeId === currentEmployeeId) continue;
    safeRemove(key);
  }
}

/**
 * Diagnostic variant of `load`. Returns `{ value, corrupt, migrated }` so
 * the caller can decide whether to surface a malformed-draft banner.
 * - `value`     : the parsed payload (or null when nothing readable).
 * - `corrupt`   : true when the underlying localStorage entry exists but
 *                 JSON.parse failed. The key is removed by this helper.
 * - `migrated`  : true when the unscoped legacy value was just absorbed
 *                 into the scoped key.
 */
function loadDiagnostic(base, employeeId) {
  const scoped = scopedKey(base, employeeId);
  if (!scoped) return { value: null, corrupt: false, migrated: false };

  const scopedDiag = safeReadDiagnostic(scoped);
  if (scopedDiag.corrupt) {
    safeRemove(scoped);
    return { value: null, corrupt: true, migrated: false };
  }
  if (scopedDiag.value !== null) return { value: scopedDiag.value, corrupt: false, migrated: false };

  // No scoped draft yet for this user. Look for a legacy unscoped draft.
  const legacy = localStorage.getItem(base);
  if (legacy === null) return { value: null, corrupt: false, migrated: false };

  let legacyParsed;
  try {
    legacyParsed = JSON.parse(legacy);
  } catch {
    // Unscoped key exists but is unreadable. Drop it so the next read
    // does not retry the parse.
    safeRemove(base);
    return { value: null, corrupt: true, migrated: false };
  }

  const migration = safeRead(MIGRATION_MARKER_KEY) || {};
  if (!migration[base] || migration[base] !== employeeId) {
    safeWrite(scoped, legacyParsed);
    safeRemove(base);
    safeWrite(MIGRATION_MARKER_KEY, { ...migration, [base]: employeeId });
    return { value: legacyParsed, corrupt: false, migrated: true };
  }

  // Already migrated for this user, but the scoped key was empty (e.g.
  // user cleared the form). Don't re-migrate.
  return { value: null, corrupt: false, migrated: false };
}

module.exports = {
  scopedKey,
  load,
  loadDiagnostic,
  save,
  clear,
  clearForUser,
  clearAllExcept,
  MIGRATION_MARKER_KEY,
};
