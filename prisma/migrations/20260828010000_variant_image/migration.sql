-- Expand only: a nullable column with no default and no backfill.
--
-- Nullable is not a convenience here, it is the honest shape. A product without a photo
-- is normal, and every existing row has no image until the next catalogue sync writes
-- one -- so "null" has to mean "we do not have one", never "this failed".
--
-- Rollback-safe one version back: the previous release simply does not select it.
ALTER TABLE "variant_index" ADD COLUMN "imageUrl" TEXT;
