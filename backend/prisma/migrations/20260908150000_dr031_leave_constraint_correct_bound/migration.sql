-- DR-031 (audit, 2026-09-08): the round-20 fix migration
-- 20260908140000_dr009_leave_overlap_constraint_fix used
-- daterange("startDate", ("endDate" + 1), '[]') as the EXCLUDE bound.
--
-- [DR-031-SQLFIX 2026-09-10]: the original file shipped with a syntax
-- bug at lines 82 + 113 — `position(''[]'' in current_def)` was
-- intended as `position('[]' in current_def)` but the doubled single
-- quotes parse as `''` (empty string) + `[]` (stray array literal) +
-- `''` (empty string), which is invalid SQL and caused
-- `prisma migrate deploy` to fail with `ERROR: syntax error at or
-- near "["` (PostgreSQL error code 42601). The fix is the literal
-- `'[]'` — the migration now correctly detects the broken combo of
-- `+ 1` arithmetic AND `'[]'` bound literal. Confirmed locally with
-- `pgsql-ast-parser`: the broken form is rejected at parse time and
-- the fixed form parses cleanly. Deploy at commit cf697e7 was marked
-- `update_failed`.
--
-- Recovery path: the bootstrap `migrate resolve --rolled-back` step
-- runs once before the next `migrate deploy` so Prisma sees no
-- errored rows and can re-apply the now-fixed SQL. Two places carry
-- this recovery — pick one depending on which runs first:
--
--   1. backend/start.sh — the intended location per render.yaml
--      (`startCommand: sh start.sh`). Idempotent, narrow, runs on
--      every cold start. Will activate when the Render dashboard
--      startCommand is re-synced from render.yaml.
--   2. .github/workflows/backend-deploy.yml — "DR-031-SQLFIX bootstrap
--      resolve" step. Runs in CI BEFORE the deploy trigger, so the
--      triggered deploy has a clear ledger. This is the effective
--      path while the dashboard is out of sync.
-- The '[]' bound INCLUDES the upper endpoint, so the constraint range
-- covers startDate..endDate+1 — one day BEYOND the actual leave. A
-- valid request for the day AFTER the existing endDate was rejected
-- as overlapping (e.g. an approved 2026-10-14 request blocked an
-- otherwise valid 2026-10-15 request, while the matching 2026-10-16
-- control returned 201 — the bug).
--
-- The correct bound is '[)' (inclusive lower, exclusive upper). With
-- (endDate + 1) and '[)', the range covers exactly {startDate, ...,
-- endDate}, same shape as daterange("startDate", "endDate", '[]') but
-- spelled with endDate+1 so leap-year roll-overs (Feb 28 -> Feb 29 ->
-- Mar 1) behave identically to every other day boundary.
--
-- Per the Phase-4 P0 append-only rule we DO NOT edit the broken
-- predecessor migration. This migration is the authoritative repair.
-- It INSPECTS the installed definition with pg_get_constraintdef,
-- DROPs the broken version if found, and RECREATES it with the
-- correct bound. The PL/pgSQL block makes it idempotent on every
-- cold start: if no constraint exists, create it; if the constraint
-- has the wrong bound, drop and recreate; if the constraint is
-- already correct, no-op. A final sanity check re-reads
-- pg_get_constraintdef after the rewrite and raises an exception if
-- the broken combo is still present — the migration fails loudly
-- rather than silently shipping the wrong shape.
--
-- Why this also fixes bootstrap (the doc's "fix bootstrap separately"):
-- the predecessor 20260902220220_dr009_leave_overlap_constraint
-- references snake_case columns "start_date" / "end_date" that do
-- NOT exist in schema.prisma (they are camelCase with no @map). That
-- migration ERRORED on every apply and NEVER created a constraint.
-- A clean replay from scratch therefore arrives at THIS migration
-- with no constraint present, which the PL/pgSQL block handles
-- cleanly. A database that ONLY has the round-20 fix migration's
-- broken constraint will be repaired here. A database that was
-- manually reconciled to a correct constraint is left alone.
--
-- Why the application precheck at leave.js is NOT touched: its
-- predicate (existing.startDate <= new.endDate AND existing.endDate
-- >= new.startDate) is the canonical inclusive interval-overlap
-- test for @db.Date columns. It correctly allows adjacent days
-- ([14-Oct] vs [15-Oct] is FALSE) and correctly rejects the same-day
-- case ([14-Oct] vs [14-Oct] is TRUE). The doc's "preflight genuine
-- overlaps without deleting valid adjacent requests" requirement
-- is satisfied by the existing precheck — see the unit tests in
-- __tests__/leaveRules.test.js ("rangesOverlap") which pin this
-- semantic against any future rewrite.
--
-- Why the route's catch block at leave.js (isLeaveOverlapConstraint
-- Error -> 409 LEAVE_OVERLAP) is NOT touched: it already maps the
-- raw P2010 / "no_overlap_leave" constraint violation to a 409
-- domain response with the message "This leave overlaps an existing
-- request", satisfying the doc's "map constraint rejection to a
-- useful domain response instead of generic 500" requirement.

CREATE EXTENSION IF NOT EXISTS btree_gist;

DO $$
DECLARE
  current_def text;
  constraint_exists boolean := false;
  bad_definition boolean := false;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'no_overlap_leave'
  ) INTO constraint_exists;

  IF constraint_exists THEN
    SELECT pg_get_constraintdef(oid) INTO current_def
      FROM pg_constraint WHERE conname = 'no_overlap_leave';

    -- The broken combo is daterange with (endDate + 1) AND '[]'
    -- (inclusive upper) — that adds the day after end to the range.
    -- The correct combos are (endDate + 1) WITH '[)' OR endDate WITH
    -- '[]'. We detect the broken combo by checking for the
    -- simultaneous presence of the "+ 1" arithmetic and the "'[]'"
    -- bound literal in the rendered definition.
    bad_definition := (
      position('+ 1' in current_def) > 0
      AND position('[]' in current_def) > 0
    );

    IF bad_definition THEN
      ALTER TABLE "leave_request" DROP CONSTRAINT "no_overlap_leave";
      constraint_exists := false;
      RAISE NOTICE 'DR-031: dropped broken no_overlap_leave constraint (inclusive upper bound on (endDate + 1))';
    ELSE
      RAISE NOTICE 'DR-031: existing no_overlap_leave constraint is already correct, skipping';
    END IF;
  END IF;

  IF NOT constraint_exists THEN
    -- Authoritative recreation: (endDate + 1) with '[)' (exclusive
    -- upper bound). Range covers exactly {startDate, ..., endDate}.
    ALTER TABLE "leave_request"
      ADD CONSTRAINT "no_overlap_leave"
      EXCLUDE USING gist (
        "employee_id" WITH =,
        daterange("startDate", ("endDate" + 1), '[)') WITH &&
      )
      WHERE ("status" IN ('PENDING', 'APPROVED'));
  END IF;

  -- Final sanity check: re-read pg_get_constraintdef on the installed
  -- constraint and raise if the broken combo is still present. Failing
  -- loudly is preferable to silently shipping the wrong shape.
  SELECT pg_get_constraintdef(oid) INTO current_def
    FROM pg_constraint WHERE conname = 'no_overlap_leave';

  IF position('+ 1' in current_def) > 0
     AND position('[]' in current_def) > 0 THEN
    RAISE EXCEPTION 'DR-031: no_overlap_leave still has broken inclusive-upper form: %', current_def;
  END IF;
END$$;
