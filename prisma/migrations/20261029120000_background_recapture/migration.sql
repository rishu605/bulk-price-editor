-- A recapture from the recapture page, run by the worker when its wholesale prices need more
-- quantity-ladder reads than the page can wait on, and followed by the page (#1105).
--
-- Expand only: a new table, read and written by nothing in the previous release. Rolled
-- back one version, the page recaptures inline as it did, and the table sits unread.
CREATE TABLE "baseline_recaptures" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "segmentId" TEXT,
    "stale" BOOLEAN NOT NULL DEFAULT false,
    "scope" INTEGER NOT NULL,
    "confirmation" TEXT,
    "confirmedOver" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "actor" TEXT,
    "phase" TEXT NOT NULL,
    "progress" JSONB,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "heartbeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "outcome" JSONB,
    "failure" TEXT,

    CONSTRAINT "baseline_recaptures_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "baseline_recaptures_shopId_startedAt_idx" ON "baseline_recaptures"("shopId", "startedAt");

ALTER TABLE "baseline_recaptures" ADD CONSTRAINT "baseline_recaptures_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One recapture per shop at a time, held by the database rather than a check: two of them
-- over the same baselines collide on the one-current-baseline index part-way through, and
-- one stops half-written. A recapture that has gone quiet is closed before the next is
-- claimed (`claimRecapture`), so a worker that died never holds the shop for good.
CREATE UNIQUE INDEX "baseline_recaptures_one_running"
  ON "baseline_recaptures" ("shopId")
  WHERE "finishedAt" IS NULL;
