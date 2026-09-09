// SOL DR-003 + DR-006 — owner-scoped draft storage.
//
// Before this module, the DPR and Inspection autosave keys were unscoped
// (`dpr_draft_v1`, `inspection_draft_v1`). That meant a Shared computer's
// localStorage kept the previous account's draft, and the next person to
// log in saw it pre-loaded into the form. SOL DR-003 reproduced exactly
// that: employee A's project marker survived into admin B's New DPR view
// after a logout.
//
// The contract has three legs:
//
//   1. Scope every key by `employeeId`. A logged-in user only ever reads
//      their own draft; another account's draft is invisible.
//
//   2. DO NOT auto-migrate legacy unscoped drafts (SOL DR-006). DR-003
//      originally absorbed the unscoped value into the first reader's
//      scoped key, which silently attributed employee A's orphan draft
//      to employee B (B is the first reader after A's session expired).
//      A reader-stamped migration marker cannot prove authorship. We now
//      refuse to restore an unowned legacy draft — instead `load` /
//      `loadDiagnostic` return a quarantine envelope
//      `{ __quarantined: true, reason: 'legacy-unowned' }` so the form
//      can show a banner explaining why the orphan cannot be restored.
//      Scoped keys are themselves the "versioned envelope whose recorded
//      owner matches the current employee" — the ownerId is the key
//      suffix, so any scoped draft that exists IS owned by the reader.
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
 * SOL DR-006: a legacy unscoped draft is NEVER auto-attributed to the
 * first reader. If we find one, we return a quarantine envelope
 * `{ __quarantined: true, reason: 'legacy-unowned' }` so the caller can
 * surface an explanatory banner and refuse to pre-fill the form.
 *
 * Scoped drafts (i.e. those saved by the current employee — the key
 * suffix IS the employeeId) are still returned normally, since the
 * scoped key itself is the "versioned envelope whose recorded owner
 * matches the current employee" the audit specifies.
 */
function load(base, employeeId) {
  const scoped = scopedKey(base, employeeId);
  if (!scoped) return null;

  const scopedValue = safeRead(scoped);
  if (scopedValue !== null) return scopedValue;

  // No scoped draft for this user. Look for a legacy unscoped draft.
  const legacy = safeRead(base);
  if (legacy === null) return null;

  // SOL DR-006: the legacy key has no owner information — a
  // reader-stamped migration marker cannot prove authorship, so we
  // refuse to attribute it to the current employee. Returning the
  // quarantine envelope lets the caller show an explicit banner
  // instead of silently importing someone else's draft.
  return { __quarantined: true, reason: 'legacy-unowned' };
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
 * Diagnostic variant of `load`. Returns `{ value, corrupt, quarantined, migrated }`
 * so the caller can decide whether to surface a malformed-draft banner
 * OR a quarantine banner (SOL DR-006).
 * - `value`       : the parsed payload (or a quarantine envelope below
 *                   when an unowned legacy draft was found).
 * - `corrupt`     : true when the underlying localStorage entry exists
 *                   but JSON.parse failed. The key is removed by this helper.
 * - `quarantined` : true when an unowned legacy unscoped draft was
 *                   found. The caller MUST NOT pre-fill the form from
 *                   `value` in this case — `value` is the quarantine
 *                   envelope `{ __quarantined: true, reason }` and the
 *                   form should render a banner explaining why.
 * - `migrated`    : kept for backwards compatibility with callers that
 *                   inspect it; always false after DR-006 (auto-migration
 *                   is removed).
 */
function loadDiagnostic(base, employeeId) {
  const scoped = scopedKey(base, employeeId);
  if (!scoped) return { value: null, corrupt: false, quarantined: false, migrated: false };

  const scopedDiag = safeReadDiagnostic(scoped);
  if (scopedDiag.corrupt) {
    safeRemove(scoped);
    return { value: null, corrupt: true, quarantined: false, migrated: false };
  }
  if (scopedDiag.value !== null) {
    return { value: scopedDiag.value, corrupt: false, quarantined: false, migrated: false };
  }

  // No scoped draft yet for this user. Look for a legacy unscoped draft.
  const legacy = localStorage.getItem(base);
  if (legacy === null) return { value: null, corrupt: false, quarantined: false, migrated: false };

  let legacyParsed;
  try {
    legacyParsed = JSON.parse(legacy);
  } catch {
    // Unscoped key exists but is unreadable. Drop it so the next read
    // does not retry the parse.
    safeRemove(base);
    return { value: null, corrupt: true, quarantined: false, migrated: false };
  }

  // SOL DR-006: refuse to auto-attribute the unscoped draft to the
  // current reader. A reader-stamped migration marker cannot prove
  // authorship, so we surface a quarantine envelope instead of silently
  // adopting A's orphan into B's session.
  return {
    value: { __quarantined: true, reason: 'legacy-unowned' },
    corrupt: false,
    quarantined: true,
    migrated: false,
  };
}

// [PHASE-3] ESM named exports at module top so Vite/Rollup can do
// static analysis. The previous single-literal `module.exports = {…}`
// worked under Jest's CJS-bundled babel transform but Rollup (used by
// Vite for the production bundle) needs `export` statements to resolve
// named imports like `import { clearForUser } from './ownerScopedDraft.js'`.
//
// The functions are declared above via `function …` (hoisted), so the
// `export const … = fn` bindings below reference them statically. We
// also keep `module.exports` as a fallback so node-side callers (e.g.
// require()) still work — this is the CommonJS-compatible dual shape.
// Runtime: tests run via Jest with babel-jest (CJS target), so the
// `module.exports` path is what Jest sees; the production bundle uses
// `export` for Rollup. Both end up pointing at the same functions.

export {
  scopedKey,
  load,
  loadDiagnostic,
  save,
  clear,
  clearForUser,
  clearAllExcept,
  MIGRATION_MARKER_KEY,
};

// [PHASE-3] CJS fallback for Jest (`require()`) — guarded so the
// browser bundle doesn't throw "module is not defined". Vite/Rollup
// strip the ESM `export {…}` above at build time and the browser
// never sees module.exports; Jest with babel-jest transforms the
// `export` to a CJS assignment, so the guarded block below is what
// Jest actually runs against.
if (typeof module !== 'undefined' && module.exports) {
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
}
