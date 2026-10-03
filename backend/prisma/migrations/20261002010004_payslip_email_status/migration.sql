-- ─────────────────────────────────────────────────────────────────────────────
-- [Payslips Stage 1 / commit 3] Add email-status audit columns to payslip
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Commit 2 added upload/revoke/purge audit but no email-status tracking. The
-- commit-3 publish flow stamps publishedAt/publishedById in a single
-- transaction and then *queues* the recipient email via setImmediate (so the
-- HTTP response returns immediately — a slow Resend call must never block
-- the publish ack). The queued send can succeed, fail, or be skipped
-- (recipient opted out, no address, type muted). Without durable columns the
-- "did this recipient ever get the email" question is unanswerable from
-- audit alone — every retry is blind.
--
-- Three additive nullable columns:
--   email_status         text       'PENDING' (default) | 'SENT' | 'FAILED'
--                                   | 'SKIPPED_OPT_OUT' | 'SKIPPED_NO_ADDRESS'
--                                   | 'SKIPPED_TYPE_MUTED'
--   email_sent_at        timestamp  stamp on successful send
--   email_failed_reason  varchar(500) last error message on FAILED
--
-- Why a free-form String and not an enum:
--   * Matches the convention EmailLog.status already uses (round-25) so the
--     dispatch surfaces stay consistent across modules.
--   * Adding a new status is a code change, not a migration. The "I added a
--     new value the older readers don't know" risk is bounded — the column
--     is read on the employee's "my payslips" list surface and the admin
--     coverage view, neither of which gates on the literal value.
--
-- Privacy discipline:
--   * No salary figures anywhere. `email_failed_reason` is capped at 500
--     chars and the lib/payslip.js helper sanitises PII substrings (PAN,
--     UAN, "salary", "net", "gross", "basic", "hra") out of the persisted
--     reason before this column is touched.
--   * Status string never includes a recipient email address — Resend's
--     transport log already covers that; this column is the audit's view.
--
-- Idempotency: every ALTER wrapped in `IF NOT EXISTS` via
-- information_schema so a re-run is a no-op (same shape as
-- 20261002010003_payslip_purge_columns).
--
-- Rollback (operator-only):
--   ALTER TABLE public.payslip DROP COLUMN IF EXISTS email_status;
--   ALTER TABLE public.payslip DROP COLUMN IF EXISTS email_sent_at;
--   ALTER TABLE public.payslip DROP COLUMN IF EXISTS email_failed_reason;
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'payslip' AND column_name = 'email_status'
  ) THEN
    ALTER TABLE public.payslip
      ADD COLUMN email_status text NOT NULL DEFAULT 'PENDING';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'payslip' AND column_name = 'email_sent_at'
  ) THEN
    ALTER TABLE public.payslip ADD COLUMN email_sent_at timestamp(3);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'payslip' AND column_name = 'email_failed_reason'
  ) THEN
    ALTER TABLE public.payslip ADD COLUMN email_failed_reason varchar(500);
  END IF;
END$$;