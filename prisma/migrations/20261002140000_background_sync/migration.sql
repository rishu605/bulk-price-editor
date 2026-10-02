-- A catalogue sync runs in the worker and Home follows it (#801).
--
-- Expand only: new nullable columns, read by nothing in the previous release.
ALTER TABLE "shops" ADD COLUMN "syncStartedAt" TIMESTAMP(3);
ALTER TABLE "shops" ADD COLUMN "syncPhase" TEXT;
ALTER TABLE "shops" ADD COLUMN "syncProgress" JSONB;
ALTER TABLE "shops" ADD COLUMN "syncHeartbeatAt" TIMESTAMP(3);
ALTER TABLE "shops" ADD COLUMN "syncFailure" TEXT;
