-- Products webhooks persisted by the web process and handled by the worker (#811).
--
-- Expand only: two nullable-or-defaulted columns and two indexes, none of which the previous
-- release reads. Rolled back one version, the route handles every delivery inline again and
-- records it as it did; rows still waiting here are left RECEIVED and pruned after a week,
-- and the next edit or catalogue sync brings their products up to date.

-- What a queued delivery is about (the product), so one product's deliveries are taken
-- together and only the newest is handled.
ALTER TABLE "webhook_events" ADD COLUMN "subjectGid" TEXT;

-- The worker's tries at a delivery that threw, apart from Shopify's deliveries (`attempts`).
ALTER TABLE "webhook_events" ADD COLUMN "processAttempts" INTEGER NOT NULL DEFAULT 0;

-- A shop's waiting deliveries, oldest first: what the worker drains. The global
-- (status, receivedAt) index would walk every other shop's backlog to find one shop's.
CREATE INDEX "webhook_events_shopId_status_receivedAt_idx" ON "webhook_events"("shopId", "status", "receivedAt");

-- One product's waiting deliveries, which the worker coalesces.
CREATE INDEX "webhook_events_shopId_subjectGid_status_idx" ON "webhook_events"("shopId", "subjectGid", "status");
