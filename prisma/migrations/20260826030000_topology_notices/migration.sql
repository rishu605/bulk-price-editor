-- Market topology changes awaiting a merchant's decision (P5.4, edge case E15).
--
-- A market deleted or re-denominated while campaigns target it is not an error and must
-- not fail a run. It is a question: extend the campaign, or leave it. The question has
-- to survive the sync that found it -- a merchant is not usually watching when a
-- background poll runs -- so it is a row rather than a log line.
--
-- `resolvedAt` rather than a delete, so "we asked and they said ignore" stays
-- distinguishable from "we never asked". Without it, every poll would re-raise a
-- question the merchant already dismissed.
--
-- Expand-only: a new table and its indexes, nothing altered, so the previous release
-- runs unchanged against this schema.
CREATE TABLE "topology_notices" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,

    "kind" TEXT NOT NULL,
    "priceListGid" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "detail" TEXT NOT NULL,

    -- Campaigns targeting this price list when the change was found.
    "campaignIds" TEXT[] DEFAULT ARRAY[]::TEXT[],

    "resolvedAt" TIMESTAMP(3),
    "resolution" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "topology_notices_pkey" PRIMARY KEY ("id")
);

-- One open notice per market per kind. A poll every fifteen minutes must not stack up
-- ninety-six copies of "this market is gone" by the next morning.
CREATE UNIQUE INDEX "topology_notices_open_key"
  ON "topology_notices"("shopId", "priceListGid", "kind")
  WHERE "resolvedAt" IS NULL;

CREATE INDEX "topology_notices_shopId_createdAt_idx" ON "topology_notices"("shopId", "createdAt");

ALTER TABLE "topology_notices" ADD CONSTRAINT "topology_notices_shopId_fkey"
  FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
