-- Market and B2B price list topology (P1.2).
--
-- `adjustmentBps` records a parent percentage adjustment in basis points rather than
-- expanding it into a mirrored row per variant: a 500K-variant catalogue across four
-- markets would otherwise be two million rows restating one percentage. Null means the
-- list stores fixed per-variant prices, which are mirrored into price_surface_entries
-- as usual.
--
-- Expand-only: a new table and its indexes.
CREATE TABLE "price_lists" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "priceListGid" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "surfaceKind" "SurfaceKind" NOT NULL DEFAULT 'MARKET',
    "catalogGid" TEXT,
    "catalogTitle" TEXT,
    "adjustmentBps" INTEGER,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "price_lists_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "price_lists_shopId_priceListGid_key" ON "price_lists"("shopId", "priceListGid");
CREATE INDEX "price_lists_shopId_surfaceKind_idx" ON "price_lists"("shopId", "surfaceKind");

ALTER TABLE "price_lists" ADD CONSTRAINT "price_lists_shopId_fkey"
  FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
