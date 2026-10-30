-- These counts distinguish unpriced BOQ lines from non-line diagnostics in
-- withheld_count. NULL preserves the fact that older snapshots lack them.
BEGIN;

ALTER TABLE public.boq_snapshot
  ADD COLUMN IF NOT EXISTS priced_line_count integer,
  ADD COLUMN IF NOT EXISTS unpriced_line_count integer;

DO $$
DECLARE
  snapshots_rls_enabled boolean;
  snapshot_policy_count integer;
BEGIN
  SELECT relrowsecurity INTO snapshots_rls_enabled
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'boq_snapshot';
  SELECT count(*) INTO snapshot_policy_count
    FROM pg_policy WHERE polrelid = 'public.boq_snapshot'::regclass;

  IF snapshots_rls_enabled IS NOT TRUE OR snapshot_policy_count <> 2 THEN
    RAISE EXCEPTION 'BOQ snapshot pricing counts require the existing RLS lockdown';
  END IF;
END$$;

COMMIT;