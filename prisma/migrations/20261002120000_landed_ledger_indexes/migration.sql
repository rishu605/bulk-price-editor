-- CLAMPED is a landed state (#792), so the two partial indexes over the ledger move with it.
--
-- A clamped price is written and read back like any other; it used to be recorded as
-- VERIFIED, and is now recorded as CLAMPED. The drift lookup reads every landed row
-- (`status IN ('VERIFIED', 'CLAMPED')`), and a partial index on `status = 'VERIFIED'` alone
-- cannot serve that: Postgres falls back to sorting the shop's whole ledger, which is the
-- one-second-per-page-load sort `variant_changes_drift_lookup` was built to remove.
--
-- The unfinished-rows index is the mirror image. CLAMPED rows are settled history; left in
-- an index meant to hold only work in flight, they would grow it with every clamped run.
--
-- Rollback-safe: the previous release asks for `status = 'VERIFIED'`, and for unfinished
-- rows by name, both of which imply the new predicates, so its queries keep an index.
CREATE INDEX "variant_changes_landed_lookup"
  ON "variant_changes" ("shopId", "variantGid", "priceListGid", "verifiedAt" DESC)
  WHERE "status" IN ('VERIFIED', 'CLAMPED');
DROP INDEX IF EXISTS "variant_changes_drift_lookup";

CREATE INDEX "variant_changes_unsettled"
  ON "variant_changes" ("runId", "status")
  WHERE "status" NOT IN ('VERIFIED', 'CLAMPED', 'SKIPPED', 'REVERTED');
DROP INDEX IF EXISTS "variant_changes_unverified";
