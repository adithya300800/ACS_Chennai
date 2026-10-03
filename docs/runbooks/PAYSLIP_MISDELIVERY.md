# Payslip Misdelivery Runbook (DRAFT — full content lands in commit 8)

> **Placeholder.** The full runbook is written as part of commit 8 by the backend
> engineer. It will cover: triage, revoke, purge, what the script does NOT do,
> and the human step (HR must phone the wrong recipient directly — not email).
>
> See `docs/plans/PAYSLIPS_STAGE1_ORDER.md` §3 commit 8 for the full outline.

**Pre-flight (per order §2):** before any operator runs anything, they must
source `scripts/db-host-guard.sh` and confirm `DB_HOST_OK=1` is set. The purge
script itself re-checks the host and refuses to run against production.
