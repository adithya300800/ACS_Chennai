-- ─────────────────────────────────────────────────────────────────────────────
-- DR-021 — additive `inspection_id` on `notification`
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Trigger:
--   Notification identity / targets / commit outcomes diverge. The audit's
--   reproduction: a new rejection notification used a numeric streamed ID
--   (`id: Date.now()` from emitNotification) and the client `PUT /:notifId/read`
--   came back 404 because the actual persisted row's id is a UUID. The bell's
--   SSE-list dedupe also breaks for the same reason — the numeric SSE id never
--   matches the persisted UUID returned by /list, so the user sees duplicates.
--
--   Carrying `inspection_id` mirrors `dpr_id` / `leave_request_id` /
--   `training_enrollment_id`. The column is NULLABLE + additive so existing
--   rows and writers are untouched (no backfill required — old notification
--   prose is not parsed to invent targets, per DR-021 rollout).
--
-- Effect:
--   - New transitions through `transitionInspectionRecord` (REJECT / CLOSE /
--     ACKNOWLEDGE / SUBMIT) persist `inspectionId` on the resulting
--     notification row.
--   - `GET /api/dpr/notifications/list` selects `inspectionId` alongside the
--     existing ids so the bell can route inspection notifications.
--   - No change to the SSE wire shape beyond the SSE id bug fix (separate
--     commit) — this migration is purely schema-side.
--
-- Rollout: forward-only migration. No data backfill. Old notifications keep
-- `inspectionId = null`; the bell degrades to a no-target message surface for
-- those rows (same as today's "no typed target" branch).
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "notification"
  ADD COLUMN "inspection_id" TEXT;

-- Optional index — mirror the dprId / leaveRequestId / trainingEnrollmentId
-- pattern at backend/prisma/schema.prisma:522-529. A pure nullable FK column
-- is cheap; the index supports the same future JOIN queries.
CREATE INDEX "notification_inspection_id_idx" ON "notification" ("inspection_id");