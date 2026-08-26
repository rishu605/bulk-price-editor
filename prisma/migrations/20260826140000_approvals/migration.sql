-- Two-person rule for high-blast-radius campaigns (P6.5).
--
-- Aimed at Plus organisations where a pricing change needs sign-off. The point is not the
-- record -- the audit log already has that -- it is that a campaign above the threshold
-- physically cannot run until somebody other than its author says so.
--
-- `requestedBy` and `approvedBy` are separate columns rather than a list, because the
-- whole value of a two-person rule is that they are two different people, and a schema
-- that cannot express "the same person twice" as an error would let it happen.
--
-- Expand-only: a new table and its indexes.
CREATE TABLE "approvals" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,

    "requestedBy" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- What the campaign would change when approval was asked for. Recorded so an
    -- approver is judging the campaign they were shown, not one edited since.
    "variantsAtRequest" INTEGER NOT NULL,

    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "declinedBy" TEXT,
    "declinedAt" TIMESTAMP(3),
    "note" TEXT,

    CONSTRAINT "approvals_pkey" PRIMARY KEY ("id")
);

-- One open request per campaign. Two people asking at once is one question.
CREATE UNIQUE INDEX "approvals_open_key"
  ON "approvals"("campaignId")
  WHERE "approvedAt" IS NULL AND "declinedAt" IS NULL;

CREATE INDEX "approvals_shopId_requestedAt_idx" ON "approvals"("shopId", "requestedAt");

ALTER TABLE "approvals" ADD CONSTRAINT "approvals_shopId_fkey"
  FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_campaignId_fkey"
  FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
