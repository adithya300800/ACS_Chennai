# Google Sign-In Allowlist

**Goal:** offer "Sign in with Google" as a parallel sign-in path on the
ACS Chennai employee portal, gated by a per-email allowlist so a
Gmail address is *never* sufficient on its own to sign in.

**Owner:** anyone with a Google Cloud project, Render dashboard access,
and the database connection string.

**Hard contract:**

- Zoho sign-in is unchanged. The new path is strictly additive.
- An `@acschennai.com` address must continue to use Zoho. The script
  refuses to allowlist an `@acschennai.com` row, and the server
  route rejects Google logins from those emails via the (separate)
  Zoho domain gate at `backend/src/lib/auth.js`.
- The Google `id_token` is verified with `jose` against Google's JWKS
  (signature + audience + issuer + email_verified). The Zoho path
  still uses the unverified-id_token path — bringing it to parity is
  out of scope for this round.
- All four denial modes (not_allowlisted, sub_mismatch,
  email_not_verified, token_invalid) return the same generic
  `GOOGLE_DENIED` code to the client. The specific reason is logged
  server-side only; tokens are never logged.
- `GOOGLE_LOGIN_ENABLED` defaults OFF, so this code can ship before
  the Google Cloud OAuth client exists.

---

## 1. Database

The new table is `public.google_login_allowlist`. It is shipped via a
single additive migration:

```
backend/prisma/migrations/20261014000000_google_login_allowlist/migration.sql
```

- Primary key: `id text` (UUID-shaped, mirrors `employees.id`).
- Unique key: `email` (CHECK constraint enforces `email = lower(email)`,
  so the lookup is case-insensitive without a functional index).
- Foreign key: `user_id text NULL REFERENCES employees(id) ON DELETE
  SET NULL`. Optional; pre-link an allowlist row to a specific
  Employee (e.g. a Gmail user who already has a Zoho-provisioned
  account) by passing `--user` to the script.
- RLS: deny both `anon` and `authenticated`. The app connects as
  the `postgres` role (BYPASSRLS). The migration is idempotent
  (`CREATE TABLE IF NOT EXISTS`, `DO` blocks for the RLS / CHECK).

### Manual apply (only if `prisma migrate deploy` fails)

The migration is idempotent, so a manual apply via the Supabase SQL
editor is safe. After running the SQL, record the migration as
applied so the next `prisma migrate deploy` doesn't try to re-run it:

```bash
npx prisma migrate resolve --applied 20261014000000_google_login_allowlist
```

---

## 2. Google Cloud Console setup

### 2.1 Create an OAuth client (one-time)

1. Open the Google Cloud project that owns the `@acschennai.com`
   workspace. (If you don't have one yet, create it under the
   organisation.)
2. **APIs & Services → OAuth consent screen**:
   - User type: **External** (Internal is GWorkspace-only).
   - Publishing status: **Testing** for the rollout; promote to
     **In production** once the test users are confirmed.
   - Scopes: `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile`.
   - Test users: add every Gmail address you'll allowlist (each must
     accept the consent screen on first login). The allowlist does
     NOT bypass the consent screen — Google requires the user to
     have authorised the app before it'll mint an `id_token` for them.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**.
   - Name: `ACS Chennai Portal — Google sign-in`.
   - **Authorized redirect URIs** — add EXACTLY these three:

     | URI                                                       | When            |
     |-----------------------------------------------------------|-----------------|
     | `http://localhost:10000/api/auth/google/callback`         | Local dev       |
     | `http://localhost:3000/api/auth/google/callback`          | Frontend dev    |
     | `https://acs-chennai.onrender.com/api/auth/google/callback` | Production API  |

     **Do NOT** add `https://acschennai.com/api/auth/google/callback` —
     the apex is a CORS-allowed browser origin, NOT the API host.
     API traffic lives on `acs-chennai.onrender.com` only.

   The Google login button uses the production URI by default; the
   two localhost entries are for developers running the backend
   locally with the SPA pointed at `http://localhost:10000`.

4. Copy the **Client ID** and **Client secret** — you'll paste them
   into Render in step 3.

### 2.2 Test users vs production

Until the OAuth consent screen is **In production**, only the
emails you list under "Test users" can complete the flow. If a
user outside the test list clicks the button, Google will refuse
the consent screen — and the SPA will show the generic
`GOOGLE_DENIED` toast (no internal reason is leaked).

For internal employees on the corporate Google Workspace, you can
set User type to **Internal** instead — that side-steps the test-
user gate, but the app is only visible to `@acschennai.com`
workspace users.

---

## 3. Render environment

Set the four Google env vars on the **API** service
(`acs-chennai`):

| Key                    | Value                                                          | Sync   |
|------------------------|----------------------------------------------------------------|--------|
| `GOOGLE_LOGIN_ENABLED` | `true` to enable the button; `false` (default) hides it.       | manual |
| `GOOGLE_CLIENT_ID`     | From step 2.1 (the Web-application OAuth client ID).           | manual |
| `GOOGLE_CLIENT_SECRET` | From step 2.1.                                                 | manual |
| `GOOGLE_REDIRECT_URI`  | `https://acs-chennai.onrender.com/api/auth/google/callback`    | manual |

The frontend needs **no** new env vars. Visibility is a runtime
check (`GET /api/auth/google/active`) — not a build-time flag.

To roll out gradually:

1. Deploy the code with `GOOGLE_LOGIN_ENABLED=false` (button hidden,
   no flow can fire).
2. Create the OAuth client + set the four env vars.
3. Flip `GOOGLE_LOGIN_ENABLED=true`. The button appears on the next
   page load.
4. To disable in a hurry: flip back to `false`. No code redeploy.

---

## 4. Managing the allowlist

Use the operator CLI at `backend/scripts/google-allowlist.js`.
There are npm script shortcuts:

```bash
npm run google:allowlist:add    -- <email> [--note "..."] [--user <employee>] [--override] [--reset-sub] [--yes]
npm run google:allowlist:remove -- <email> [--yes]
npm run google:allowlist:enable -- <email> [--reset-sub] [--yes]
npm run google:allowlist:list
```

### 4.1 Host-guard

Every mutating command (`add` / `remove` / `enable`) refuses to
write to a non-localhost database without an explicit confirmation.
The trust classes are:

- `localhost` / `127.0.0.1` / `::1` / `[::1]` — trusted without
  confirmation.
- Anything else — requires ONE of:
  - `--yes` on the command line, OR
  - an interactive prompt typed into a TTY that **exactly matches**
    the DATABASE_URL host.

If neither is available (CI with no TTY, no `--yes`), the script
exits non-zero with the target host echoed. It never silently
proceeds.

`list` is read-only and never gated.

`--user` pointing at an **admin** Employee requires `--yes` even on
localhost — a wrong link lets a Gmail user inherit admin permissions.

### 4.2 Common recipes

Add a Gmail user, let first login create a fresh Employee by matching
the verified email:

```bash
npm run google:allowlist:add -- some.consultant@gmail.com --note "ticket ABC-123"
```

Pre-link to an existing Employee (use case: a Zoho-provisioned user
who needs to also be able to sign in with a personal Gmail):

```bash
npm run google:allowlist:add -- user@gmail.com \
  --user "existing@acschennai.com" \
  --note "personal Gmail, same person as existing Zoho user"
```

If `existing@acschennai.com` is already linked to a different
allowlist row, the script refuses — re-run with `--override` to
unlink the previous row.

Revoke a user's access (employee offboarded, account compromised,
or just a test):

```bash
npm run google:allowlist:remove -- some.consultant@gmail.com --yes
```

The row is soft-disabled (`isActive=false`), `googleSub` is
preserved, and every live refresh token for the linked Employee
is revoked (`reason: 'google_allowlist_removed'`). Re-enable without
disturbing the binding:

```bash
npm run google:allowlist:enable -- some.consultant@gmail.com --yes
```

If the previous Google account is gone (sub mismatch is expected
on first re-login), clear the binding first:

```bash
npm run google:allowlist:enable -- some.consultant@gmail.com --reset-sub --yes
```

Audit:

```bash
npm run google:allowlist:list
```

### 4.3 Raw-SQL equivalents

If the script is not runnable in an environment, the same writes
can be done directly. The CHECK constraint guarantees that
`email` is always lowercase, so a plain `WHERE` works without
functional indexes.

```sql
-- Add (or update note) — email must already be lowercase.
INSERT INTO public.google_login_allowlist (id, email, is_active, note, added_by)
VALUES (
  gen_random_uuid()::text,
  'some.consultant@gmail.com',
  true,
  'ticket ABC-123',
  current_user
)
ON CONFLICT (email) DO UPDATE
  SET note = EXCLUDED.note,
      updated_at = now();

-- Pre-link to an existing Employee (id is text in this schema).
UPDATE public.google_login_allowlist
   SET user_id = '<employee-id>', updated_at = now()
 WHERE email = 'some.consultant@gmail.com';

-- Soft-disable (matches `remove`).
UPDATE public.google_login_allowlist
   SET is_active = false, updated_at = now()
 WHERE email = 'some.consultant@gmail.com';

-- Re-enable.
UPDATE public.google_login_allowlist
   SET is_active = true, updated_at = now()
 WHERE email = 'some.consultant@gmail.com';

-- Clear googleSub so the next login re-binds.
UPDATE public.google_login_allowlist
   SET google_sub = null, updated_at = now()
 WHERE email = 'some.consultant@gmail.com';
```

---

## 5. Recovery from common situations

### 5.1 "I allowed the wrong Google account by accident"

The first login stamps `google_sub` on the row. If the wrong Google
account is now bound, run `enable --reset-sub` to clear the binding,
then have the user sign in with the correct Google account. The
script does not require a fresh `--add` — the allowlist row is
unchanged.

### 5.2 "An employee is gone but they keep signing in"

`remove <email> --yes`. The refresh token revocation lands
immediately; the in-flight access token (15-min TTL) is the
upper bound on staleness — same as the existing logout semantics.

### 5.3 "A new operator needs to manage the allowlist"

They need:

1. The `DATABASE_URL` (or `DIRECT_DATABASE_URL`) of the production
   database.
2. The Prisma schema in `backend/prisma/schema.prisma` (so
   `prisma generate` works).
3. The ability to pass `--yes` (or run interactively from a TTY).

No separate API token, no separate admin account — the script
uses the same connection string the backend uses. Restrict
production access at the connection-string level (VPC, IP
allowlist, password rotation, etc.) rather than at the CLI level.

### 5.4 "We don't want Google sign-in anymore"

Set `GOOGLE_LOGIN_ENABLED=false` in Render. The button disappears
on the next page load. Existing allowlist rows are untouched —
flipping back to `true` revives the flow without losing any
bindings.

To fully remove the feature: drop the table (additive migration,
no other tables depend on it):

```sql
DROP TABLE public.google_login_allowlist;
```

---

## 6. Security notes

- **No tokens in logs.** `id_token`, `access_token`, and
  `refresh_token` are never logged. The internal `logDenial(reason)`
  helper logs the PII-redacted email hash (`hashIdentifier` from
  `lib/pii.js`) and an 8-character state prefix for cross-request
  correlation. The full `state` is never logged.
- **`sub` mismatch is a strong signal.** If `allowlistRow.googleSub`
  is set and the incoming `sub` doesn't match, the login is denied
  with the generic `GOOGLE_DENIED` code and an internal
  `sub_mismatch` log line. This defends against Gmail address
  recycling: if user A deleted their Gmail and the address was
  later issued to user B by Google, the row's `sub` is the original
  A's Google-internal id, not the new B's, so B is denied.
- **Lowercase the email before the allowlist lookup.** Gmail is
  case-insensitive on the local-part. The Google `id_token`'s
  `email` claim is lowercased server-side before the lookup, so an
  admin who types `Test.User@Gmail.com` into the allowlist still
  matches an id_token that comes through as `test.user@gmail.com`.
  **We do NOT canonicalise dot / `+` aliases.** `testuser@gmail.com`
  and `t.e.s.t.u.s.e.r@gmail.com` are different addresses; a dot
  variant of an allowlisted row must be explicitly allowlisted.
- **Mixed-case email is stored lowercase.** The CHECK constraint
  guarantees it; the script's `normalizeEmail` lowercases before
  the INSERT.
- **Single-instance OAuth state.** The `oauthStateStore` is
  in-memory. A multi-instance deploy would need a shared store
  (Redis, Postgres); same constraint as the existing Zoho flow.
  Out of scope.
- **`remove` does not invalidate the in-flight access token.** The
  access token's 15-minute TTL is the upper bound on staleness;
  refresh tokens are wiped immediately so the user cannot extend
  the session past that window without re-authing. This matches
  the existing `logout` semantics.
- **No "disabled employee" concept exists in this schema.** A
  Gmail-only user (no Zoho, no password) who is `remove`d from the
  allowlist cannot re-authenticate — Google is denied, Zoho is
  `@acschennai.com`-only, and the password field is null for
  OAuth-provisioned users. The recovery path is `enable <email>`
  and the user re-runs the Google flow.
