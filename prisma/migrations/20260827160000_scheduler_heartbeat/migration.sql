-- Expand-only: a new table nothing else references, so the previous release runs
-- unchanged against this schema and a rollback needs no down migration.
CREATE TABLE "scheduler_heartbeat" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "beatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "instance" TEXT,

    CONSTRAINT "scheduler_heartbeat_pkey" PRIMARY KEY ("id")
);
