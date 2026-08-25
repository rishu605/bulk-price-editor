-- Subscription state alongside the plan tier (P5.8).
--
-- `planTier` already said which plan a shop is on. These say why we believe it: which
-- Shopify subscription, in what state, and until when the trial runs. Without them a
-- downgrade is indistinguishable from a webhook we missed, and the app would have to
-- choose between trusting a stale tier and re-querying Shopify on every request.
--
-- `developerStore` is separate from the tier rather than being a fifth tier, because a
-- dev or partner store is not on a plan at all -- it is exempt from billing while still
-- being on whatever tier it is testing.
--
-- Expand-only: new nullable columns with defaults, so the previous release reads this
-- schema unchanged.
ALTER TABLE "shops" ADD COLUMN "subscriptionGid" TEXT;
ALTER TABLE "shops" ADD COLUMN "subscriptionStatus" TEXT;
ALTER TABLE "shops" ADD COLUMN "trialEndsAt" TIMESTAMP(3);
ALTER TABLE "shops" ADD COLUMN "developerStore" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "shops" ADD COLUMN "planChangedAt" TIMESTAMP(3);

CREATE INDEX "shops_subscriptionStatus_idx" ON "shops"("subscriptionStatus");
