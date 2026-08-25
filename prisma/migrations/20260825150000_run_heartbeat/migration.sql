-- Run liveness, so a killed worker's run can be reclaimed rather than sitting in
-- EXECUTING forever (P2.8). Expand-only: the column is nullable and the index is
-- additive, so the previous release runs unchanged against this schema.
ALTER TABLE "campaign_runs" ADD COLUMN "heartbeatAt" TIMESTAMP(3);

CREATE INDEX "campaign_runs_status_heartbeatAt_idx" ON "campaign_runs"("status", "heartbeatAt");
