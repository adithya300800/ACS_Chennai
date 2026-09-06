-- Drop the standalone RFI feature (N2 Phase C) and unwind the
-- VariationOrder.reference_rfi_id FK that referenced it.
-- VOs still work standalone — escalation-to-variation from an RFI is gone.
ALTER TABLE "variation_order" DROP CONSTRAINT IF EXISTS "variation_order_reference_rfi_id_fkey";
ALTER TABLE "variation_order" DROP COLUMN IF EXISTS "reference_rfi_id";
DROP TABLE IF EXISTS "rfi" CASCADE;
DROP TYPE IF EXISTS "RfiStatus";
