# SHA-Verify Token Sync — Steps for the Operator

> **Context (Phase 4 P0 follow-up):** the backend-deploy workflow's
> SHA-verify step (`Verify exact release SHA via /version`) polls
> `https://acs-chennai.onrender.com/version` with the `INTERNAL_API_TOKEN`
> GitHub secret. Render's `INTERNAL_API_TOKEN` env var is a different
> value, so the workflow gets `HTTP 403 {"error":"Forbidden"}` from
> `/version` and the step times out after 5 minutes — failing the deploy
> workflow even though the actual deploy succeeded.

---

## Why the two values drifted

| Side            | Source                                  | Last updated            |
|-----------------|-----------------------------------------|-------------------------|
| GitHub Actions  | `secrets.INTERNAL_API_TOKEN`            | 2026-09-03T17:41:48Z    |
| Render service  | `INTERNAL_API_TOKEN` env var on `srv-da9jvkhf2nfc73fpq230` | earlier (pre-2026-09-03) |

These two values were never linked. The deploy workflow was added
later, and whoever wired it up used the GitHub-side value as the
expected value to send — but the actual gate on Render was the older
value. Result: the workflow's `X-Internal-Token` header never matches.

---

## Step 1 — decide which side is canonical

The token is a shared secret. Pick ONE side to be authoritative and
mirror it to the other. Two simple models:

| Model | Pros | Cons |
|-------|------|------|
| **A. GitHub is canonical, rotate Render** | Rotate at the GitHub side, then sync to Render via dashboard. Both ends move together. | Need to do it twice on each rotation. |
| **B. Render is canonical, rotate GitHub** | Render's value has been live longer and used by `/version` callers (none today, but possible). | Same — need to do it twice. |

**Recommended: model A.** GitHub secrets are easier to rotate and audit
(`gh secret list` + `gh secret set` vs. Render dashboard). The Render
env var rarely changes, so making Render the follower is the lowest-friction
choice.

If you prefer model B (or both already rotated), the steps are the same
just with the source/target swapped.

---

## Step 2 — generate a new token value

```bash
# 32+ chars of entropy. node one-liner is fine:
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Result is something like `oG8x5B3pR2mNvYqKwL7H4xT9sZ0eDfUiAvCnMbVcW6E`.

---

## Step 3 — update GitHub Actions secret (if using model A)

```bash
# From the repo root, authenticated as adithya300800:
gh secret set INTERNAL_API_TOKEN --repo adithya300800/ACS_Chennai
# Paste the new token when prompted.

# Verify:
gh secret list --repo adithya300800/ACS_Chennai | grep INTERNAL_API_TOKEN
# Expect: INTERNAL_API_TOKEN	2026-MM-DDTHH:MM:SSZ   ← updated timestamp
```

---

## Step 4 — update Render env var

**Option 4a (dashboard):**

1. Open https://dashboard.render.com/web/srv-da9jvkhf2nfc73fpq230/env
2. Click the pencil next to `INTERNAL_API_TOKEN`
3. Paste the new value
4. Save (Render will mark the env as `syncing` for a few seconds; no
   redeploy needed — env changes take effect on next process start).

**Option 4b (API):**

```bash
# From your local shell with RENDER_API_KEY exported:
curl -fsS -X PUT \
  -H "Authorization: Bearer $RENDER_API_KEY" \
  -H "Content-Type: application/json" \
  "https://api.render.com/v1/services/srv-da9jvkhf2nfc73fpq230/env-vars/INTERNAL_API_TOKEN" \
  -d "{\"value\":\"$NEW_TOKEN\"}"
# Expect: HTTP 200 with {"value":"<masked>"}
```

> Render does NOT require a redeploy for env-only changes; the new
> value takes effect on the next process restart (next deploy, manual
> restart, or cold start).

---

## Step 5 — verify both sides agree

```bash
# 1. Hit /version with the new token from your shell:
curl -fsS -H "X-Internal-Token: $NEW_TOKEN" \
  https://acs-chennai.onrender.com/version | python3 -m json.tool

# Expect: {status:"ok", deploySha: "<sha>", ...}
# NOT 403 {"error":"Forbidden"}.
```

If you get 200 — the Render side is good.

The GitHub secret cannot be read directly (by design), but you can
prove the two agree by triggering the SHA-verify step:

```bash
# Re-run the SHA verify portion only — full deploy would touch prod.
# Easiest: push a no-op commit (e.g. update this doc) and watch the
# workflow. The "Verify exact release SHA via /version" step should
# complete in <30s instead of timing out at 5 min.
git commit --allow-empty -m "chore: trigger SHA-verify after token sync"
git push origin add-react-website

# Watch the run:
gh run watch --repo adithya300800/ACS_Chennai
```

Look for the line:

```
[poll 1] deploySha=... matches=true
```

If `matches=true` lands within 30 seconds, both ends agree.

---

## Step 6 — record the rotation

Open `memory/post-deploy-secret-rotation.md` (the existing tracking
file for Round-26 secret hygiene) and add a row:

```markdown
- 2026-09-04 — INTERNAL_API_TOKEN rotated (Phase 4 follow-up to fix
  SHA-verify drift). New value committed to GitHub secret + Render env
  var for `srv-da9jvkhf2nfc73fpq230`. Trigger: backend-deploy.yml SHA
  verify step was 403-ing on the deploy that fixed S3-6.
```

---

## What NOT to do

- **Don't `git filter-repo` to rewrite history** — the INTERNAL_API_TOKEN
  is not in git history (it's a GitHub Actions secret + Render env var).
- **Don't lower the SHA-verify step's auth requirement** — `/version`
  is the one place that confirms "this commit is the one running in
  prod"; loosening it loses the only reliable release-identity signal.
- **Don't skip the sync after rotating** — the deploy workflow WILL
  succeed for 5 minutes and then fail with "SHA never matched after
  5 minutes" the moment the next deploy fires. It's a slow-fuse CI
  bug that masquerades as a deploy timeout.

---

## Long-term fix (future PR, not required to close Phase 4)

Add a `pre-deploy` step that hits `/version` with the workflow's
secret value and asserts a 200 — fail the workflow early if the
secrets are out of sync, rather than waiting 5 minutes for SHA-verify
to time out. This is the cheapest possible "is the secret current?"
gate and would have caught the drift in seconds, not minutes.

```yaml
- name: Smoke-test INTERNAL_API_TOKEN against Render
  env:
    INTERNAL_API_TOKEN: ${{ secrets.INTERNAL_API_TOKEN }}
  run: |
    code=$(curl -fsS -o /dev/null -w '%{http_code}' -m 10 \
      -H "X-Internal-Token: $INTERNAL_API_TOKEN" \
      https://acs-chennai.onrender.com/version || echo 000)
    if [ "$code" != "200" ]; then
      echo "::error::INTERNAL_API_TOKEN GitHub secret does not match Render env (HTTP $code from /version). Sync required before deploy can succeed."
      exit 1
    fi
```
