-- Ledger for market-wide adjustments (P5.2).
--
-- Separate from variant_changes because a parent adjustment is a property of the price
-- list, not of any variant. It is one write that moves every price on the market, and
-- the thing a revert has to put back is the merchant's own prior percentage -- which
-- exists nowhere else once we have overwritten it.
--
-- `priorAdjustmentBps` is therefore the whole point of the table. Null means the list
-- had no parent adjustment at all before the campaign, which is a different instruction
-- on revert than "restore 0%": one removes the adjustment, the other pins it.
--
-- Expand-only: a new table and its indexes, nothing altered, so the previous release
-- runs unchanged against this schema.
CREATE TABLE "price_list_changes" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "priceListGid" TEXT NOT NULL,

    "priorAdjustmentBps" INTEGER,
    "appliedAdjustmentBps" INTEGER NOT NULL,

    "status" "ChangeStatus" NOT NULL DEFAULT 'PENDING',
    "failureReason" TEXT,

    "appliedAt" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "price_list_changes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "price_list_changes_runId_priceListGid_key" ON "price_list_changes"("runId", "priceListGid");
CREATE INDEX "price_list_changes_shopId_campaignId_idx" ON "price_list_changes"("shopId", "campaignId");
CREATE INDEX "price_list_changes_campaignId_status_idx" ON "price_list_changes"("campaignId", "status");

ALTER TABLE "price_list_changes" ADD CONSTRAINT "price_list_changes_shopId_fkey"
  FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "price_list_changes" ADD CONSTRAINT "price_list_changes_runId_fkey"
  FOREIGN KEY ("runId") REFERENCES "campaign_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
