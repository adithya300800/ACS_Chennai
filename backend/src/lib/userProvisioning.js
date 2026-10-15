// [feat/google-login-allowlist] Shared provisioning helper for any
// OAuth / OIDC provider that issues an employee record via verified
// email. Today the only callers are the Zoho path in routes/auth.js
// and the upcoming Google path in routes/googleAuth.js. The helper
// owns the "find or create" + P2002 race-safe re-fetch dance; the
// callers own the per-provider claim verification, the allowlist
// check, and the per-provider columns they want written into
// extraFields.
//
// Contract for callers:
//   findOrCreateEmployeeFromProvider(prisma, {
//     email,                  // required, must be lowercased by the caller
//     displayName,            // optional, sanitized via sanitizeDisplayName
//     extraFields,            // optional provider-specific columns to
//                             // merge into the create / update payload
//   })
//
// Why a helper instead of inlining the dance in each route:
//   * The P2002 race-safe re-fetch was already correct in the Zoho
//     path (P1-#9 audit) and would be easy to drift out of sync in
//     the Google path. Centralising the dance means the two providers
//     share the same error-recovery semantics.
//   * The "name from email local-part" fallback lives here too, so
//     a future provider (Okta, Auth0, etc.) gets the same behaviour
//     for free.
//
// What this helper does NOT do:
//   * It does NOT verify the OAuth id_token. Callers (auth.js for
//     Zoho, googleAuth.js for Google) own token verification.
//   * It does NOT check the Google allowlist. That is the Google
//     route's job, before this helper is even called.
//   * It does NOT mint JWTs or persist refresh-token rows. That's
//     `issueSession` in auth.js (shared via the auth route's exports).
//   * It does NOT log anything provider-specific. Callers log their
//     own audit events; this helper is silent on the happy path
//     (errors are surfaced via thrown Prisma errors).

const MAX_DISPLAY_NAME_LENGTH = 200;

// Sanitize a user-supplied display name before storing it on
// Employee.name. Defends against a hostile `name` claim (e.g. from
// a malicious OAuth provider) that tries to inject HTML/JS into the
// SPA's profile UI or shell metacharacters into a future audit log.
//
//   - Trim leading/trailing whitespace.
//   - Strip C0 control characters and DEL (0x00–0x1f, 0x7f). Keeps
//     tabs and newlines stripped — names in this product are single
//     lines; multi-line input is a strong signal of injection.
//   - Cap length at MAX_DISPLAY_NAME_LENGTH (matches the practical
//     upper bound on Employee.name in the UI).
//   - Return null if the result is empty so the caller can fall back
//     to email-local-part derivation.
function sanitizeDisplayName(raw) {
  if (raw == null) return null;
  if (typeof raw !== 'string') return null;
  // .normalize('NFKC') collapses full-width / compatibility forms so
  // an attacker can't bypass the control-char strip with a
  // zero-width or homoglyph encoding. Done before the strip so the
  // strip sees the canonical codepoints.
  const normalized = raw.normalize('NFKC').trim();
  const cleaned = normalized.replace(/[\x00-\x1f\x7f]/g, '');
  if (cleaned.length === 0) return null;
  if (cleaned.length > MAX_DISPLAY_NAME_LENGTH) {
    return cleaned.slice(0, MAX_DISPLAY_NAME_LENGTH);
  }
  return cleaned;
}

// Derive a display name from an email local-part. Mirrors the exact
// rules that were inlined in the Zoho path (dots and underscores
// become spaces, each part title-cased) so the Zoho behaviour stays
// byte-identical after the refactor.
function deriveNameFromEmail(email) {
  const local = String(email).split('@')[0] || '';
  const parts = local.replace(/[._]/g, ' ').split(' ').filter(Boolean);
  if (parts.length === 0) return local; // pathological but safe
  return parts.map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join(' ');
}

// Build the Employee row payload from caller inputs.
//
// `extraFields` is provider-specific (e.g. { zohoAccessToken,
// zohoRefreshToken } for Zoho, {} for Google on first login). The
// helper merges it verbatim into both the create and the update
// paths so neither branch can accidentally drop a column.
function buildEmployeeData({ email, displayName, extraFields }) {
  const safeName = sanitizeDisplayName(displayName);
  const name = safeName || deriveNameFromEmail(email);
  return { email, name, ...(extraFields || {}) };
}

async function findOrCreateEmployeeFromProvider(prisma, { email, displayName, extraFields }) {
  if (!email || typeof email !== 'string') {
    throw new TypeError('findOrCreateEmployeeFromProvider: email is required');
  }
  const data = buildEmployeeData({ email, displayName, extraFields });

  // Happy path: row already exists, just merge provider-specific
  // fields onto it. We use update (not upsert) so a race between
  // two concurrent logins for the same email surfaces as P2002
  // below — and is then caught and recovered.
  const existing = await prisma.employee.findUnique({ where: { email } });
  if (existing) {
    return prisma.employee.update({
      where: { email },
      data: { ...(extraFields || {}) },
    });
  }

  try {
    return await prisma.employee.create({ data });
  } catch (err) {
    if (err && err.code === 'P2002') {
      // Lost the create race. Refetch and merge the provider fields
      // onto the winner's row. If the row vanished between our
      // findUnique and the catch (extremely unlikely — would require
      // an admin deleting the employee mid-flight), rethrow.
      const winner = await prisma.employee.findUnique({ where: { email } });
      if (winner) {
        return prisma.employee.update({
          where: { email },
          data: { ...(extraFields || {}) },
        });
      }
    }
    throw err;
  }
}

module.exports = {
  findOrCreateEmployeeFromProvider,
  sanitizeDisplayName,
  deriveNameFromEmail,
  // Exposed for unit tests; not used at runtime.
  _internal: { MAX_DISPLAY_NAME_LENGTH, buildEmployeeData },
};
