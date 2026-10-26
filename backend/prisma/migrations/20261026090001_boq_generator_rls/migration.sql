-- Deny direct Supabase/PostgREST access to BOQ Generator metadata.
-- The portal uses its backend database role; authenticated and anon roles
-- must never read or write project job metadata or snapshot object paths.

BEGIN;

ALTER TABLE public.boq_job ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.boq_snapshot ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS boq_job_deny_anon ON public.boq_job;
DROP POLICY IF EXISTS boq_job_deny_authenticated ON public.boq_job;
DROP POLICY IF EXISTS boq_snapshot_deny_anon ON public.boq_snapshot;
DROP POLICY IF EXISTS boq_snapshot_deny_authenticated ON public.boq_snapshot;

CREATE POLICY boq_job_deny_anon ON public.boq_job
  FOR ALL TO anon USING (false) WITH CHECK (false);
CREATE POLICY boq_job_deny_authenticated ON public.boq_job
  FOR ALL TO authenticated USING (false) WITH CHECK (false);
CREATE POLICY boq_snapshot_deny_anon ON public.boq_snapshot
  FOR ALL TO anon USING (false) WITH CHECK (false);
CREATE POLICY boq_snapshot_deny_authenticated ON public.boq_snapshot
  FOR ALL TO authenticated USING (false) WITH CHECK (false);

DO $$
DECLARE
  jobs_rls_enabled boolean;
  snapshots_rls_enabled boolean;
  job_policy_count integer;
  snapshot_policy_count integer;
BEGIN
  SELECT relrowsecurity INTO jobs_rls_enabled
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'boq_job';
  SELECT relrowsecurity INTO snapshots_rls_enabled
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'boq_snapshot';
  SELECT count(*) INTO job_policy_count
    FROM pg_policy WHERE polrelid = 'public.boq_job'::regclass;
  SELECT count(*) INTO snapshot_policy_count
    FROM pg_policy WHERE polrelid = 'public.boq_snapshot'::regclass;

  IF jobs_rls_enabled IS NOT TRUE OR snapshots_rls_enabled IS NOT TRUE THEN
    RAISE EXCEPTION 'BOQ Generator RLS lockdown: RLS is not enabled on both tables';
  END IF;
  IF job_policy_count <> 2 OR snapshot_policy_count <> 2 THEN
    RAISE EXCEPTION 'BOQ Generator RLS lockdown: expected exactly two deny policies per table (got %, %)',
      job_policy_count, snapshot_policy_count;
  END IF;
END$$;

COMMIT;