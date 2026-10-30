-- BOQ uploads are first-class UploadIntents, but their project and display
-- name must survive confirmation and be checked again when a job claims them.
BEGIN;

ALTER TABLE public.upload_intent
  ADD COLUMN IF NOT EXISTS project_id text,
  ADD COLUMN IF NOT EXISTS original_filename text;

CREATE INDEX IF NOT EXISTS upload_intent_container_project_status_idx
  ON public.upload_intent (container, project_id, status);

COMMIT;