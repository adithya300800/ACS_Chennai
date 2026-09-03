-- DR-025 (round-20): one open AttendanceSession per Attendance row.
--
-- The previous schema had no constraint on (attendanceId, checkOut IS NULL).
-- A double-click or a buggy client could create two open sessions on the
-- same attendance row; the /api/attendance/status endpoint then picks
-- `find(s => !s.checkOut)` which returns the FIRST one and orphans the
-- rest. The admin timesheet reports under-counted work hours because the
-- second session's checkIn was never visible to anyone.
--
-- This partial unique index makes Postgres reject any second open session
-- atomically, at the DB layer. The application-level precheck at
-- /api/attendance/check-in translates the resulting P2002 (or any
-- race-window hit) into a clean 409 ALREADY_CHECKED_IN for the client.
--
-- The check-out path is unaffected: checkOut = NOT NULL means the row no
-- longer matches the partial-index predicate and a new open session can
-- be inserted after that.
--
-- CREATE UNIQUE INDEX CONCURRENTLY is preferred for production (no table
-- lock during build) but Prisma's migrate engine doesn't currently emit
-- CONCURRENTLY — operators running this in a busy environment should run
-- it manually with CONCURRENTLY before the schema migration:
--
--   CREATE UNIQUE INDEX CONCURRENTLY attendance_sessions_one_open_idx
--     ON "attendance_sessions" ("attendance_id")
--     WHERE "check_out" IS NULL;
--
-- The non-CONCURRENTLY form below is the safe Prisma-compatible default.
-- For an empty / small table this is fine; for a large production table,
-- apply the CONCURRENTLY form via a manual SQL step first.

CREATE UNIQUE INDEX "attendance_sessions_one_open_idx"
  ON "attendance_sessions" ("attendance_id")
  WHERE "check_out" IS NULL;
