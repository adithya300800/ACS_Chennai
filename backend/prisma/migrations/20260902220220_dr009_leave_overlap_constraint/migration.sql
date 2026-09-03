-- Round-20 DR-009: stop two leave requests from racing into the same
-- (employeeId, date range) window.
--
-- Background: backend/src/routes/leave.js previously validated overlap with
-- a SELECT followed by a separate INSERT. Two requests whose precheck read
-- runs concurrently both see "no overlap" and both INSERT — the second
-- silently wins, the employee ends up with two overlapping PENDING leaves
-- and the admin queue now shows them as a single block of accidental time
-- off that no one approved.
--
-- The application-side precheck stays in place: it produces better error
-- messages (which request conflicts, by id + dates + status) than the raw
-- constraint violation can. This migration adds the AUTHORITATIVE check
-- — a Postgres exclusion constraint that REJECTS any INSERT that would
-- produce an overlap, atomically, regardless of how many requests race.
--
-- Why btree_gist + EXCLUDE rather than UNIQUE:
--   * UNIQUE only catches equality, not [start,end] intervals.
--   * Without btree_gist, GIST indexes only know about geometric / range
--     types, not scalar (employee_id) columns. btree_gist lets us mix a
--     scalar equality on (employee_id) with a range-overlap operator (&&)
--     on (daterange(start_date, end_date + 1, '[]')) in the same GIST
--     index.
--   * btree_gist ships with every Supabase Postgres image, so the
--     extension is created on demand; if the running DB refuses the
--     CREATE EXTENSION (unlikely), the route handler falls back to a
--     SERIALIZABLE transaction with a pg_advisory_xact_lock keyed on
--     employee_id (see leave.js). The migration itself remains the
--     preferred path because it's atomic at the storage layer.
--
-- Why daterange(start_date, end_date + 1, '[]'):
--   * The stored startDate/endDate are calendar days (Prisma @db.Date).
--   * Inclusive overlap semantics: day X of one leave and day X of another
--     IS a conflict. A canonical inclusive range over [start, end+1) is
--     '[]' daterange(start, end + 1) — same as '[start, end+1)' but
--     spelled the way GiST && wants for the predicate to fire.
--   * endDate + 1 day is computed via (end_date + INTERVAL '1 day') so
--     February 28 / leap-year boundaries don't roll over silently.
--
-- Why partial (WHERE status IN ('PENDING','APPROVED')):
--   * REJECTED and CANCELLED leaves are terminal and should not block a
--     fresh submission — an admin can reject one request, the employee can
--     re-submit for the same dates. Without the WHERE clause, a rejected
--     leave would forever block any resubmission in that window.

-- Enable the btree_gist extension so a single GiST index can mix scalar
-- (employee_id) equality with range (daterange) overlap. No-op if the
-- extension is already present (CREATE EXTENSION IF NOT EXISTS is safe
-- to re-run).
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- The actual constraint. Two requests that overlap on (employee_id,
-- daterange([start, end+1))) will collide; the second INSERT raises
-- Prisma error code P2010 (raw query failed) with constraint name
-- "no_overlap_leave", which leave.js maps to a 409 LEAVE_OVERLAP.
ALTER TABLE "leave_request"
  ADD CONSTRAINT "no_overlap_leave"
  EXCLUDE USING gist (
    "employee_id" WITH =,
    daterange("start_date", ("end_date" + INTERVAL '1 day'), '[]') WITH &&
  )
  WHERE ("status" IN ('PENDING', 'APPROVED'));
