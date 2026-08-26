-- Expand-only, matching the baseline column added in 20260827120000. Null means this row
-- is not a tiered one, which is every row written before wholesale ladders existed.
ALTER TABLE "variant_changes" ADD COLUMN "quantityBreaks" JSONB;
