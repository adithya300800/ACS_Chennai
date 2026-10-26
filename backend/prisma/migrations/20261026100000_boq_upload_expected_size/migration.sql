-- BOQ upload intents retain the declared size so confirmation can compare it
-- exactly with the private object store's authoritative HEAD response.
BEGIN;

ALTER TABLE public.upload_intent
  ADD COLUMN IF NOT EXISTS expected_size_bytes integer;

COMMIT;