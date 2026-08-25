-- Ledger for campaign-applied product tags (P3.11).
--
-- Separate from variant_changes because tags are product-scoped where prices are
-- variant-scoped. `addedTags` is the ownership record: only tags this run genuinely
-- added are ever removed on revert, so a campaign can never delete a tag the merchant
-- put there themselves.
--
-- Expand-only: a new table and its indexes, nothing altered, so the previous release
-- runs unchanged against this schema.
CREATE TABLE "tag_changes" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "productGid" TEXT NOT NULL,
    "addedTags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "alreadyPresent" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "ChangeStatus" NOT NULL DEFAULT 'PENDING',
    "failureReason" TEXT,
    "appliedAt" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tag_changes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tag_changes_runId_productGid_key" ON "tag_changes"("runId", "productGid");
CREATE INDEX "tag_changes_shopId_campaignId_idx" ON "tag_changes"("shopId", "campaignId");
CREATE INDEX "tag_changes_campaignId_status_idx" ON "tag_changes"("campaignId", "status");

ALTER TABLE "tag_changes" ADD CONSTRAINT "tag_changes_shopId_fkey"
  FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tag_changes" ADD CONSTRAINT "tag_changes_runId_fkey"
  FOREIGN KEY ("runId") REFERENCES "campaign_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
