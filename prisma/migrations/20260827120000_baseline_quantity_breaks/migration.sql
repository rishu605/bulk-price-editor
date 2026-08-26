-- Expand-only: a nullable column, so a release one version back still reads and writes
-- these rows without noticing it. Null means "this variant had no wholesale ladder",
-- which is the common case and a real state rather than missing data.
ALTER TABLE "baselines" ADD COLUMN "quantityBreaks" JSONB;
