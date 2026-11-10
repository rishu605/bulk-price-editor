-- A large run is written in chunks, a turn on the worker's large lane each (#809, D34).
--
-- A run was one job from its plan to its end. Two shops' 100k-variant applies held both of the
-- large lane's slots for as long as Shopify took over each, and a third shop's 500-variant run
-- waited for one of them to finish; a worker restarted mid-run left its run to be reclaimed as
-- Partial and replanned whole by Resume. Now a run of more than `RUN_CHUNK_ROWS` prices on the
-- bulk path plans and ledgers every price in its first turn, then writes them a chunk a turn,
-- each its own bulk operation, giving its slot to whoever waits between turns. The ledger is the
-- plan: a turn takes the next PENDING rows, and a turn after a restart starts there.
--
-- One row per such run, beside its `campaign_runs` row: whether a turn holds it now
-- (`waitingSince`), how many turns it has taken and how many died, and what its last turn needs
-- from the plan (`carry`). In a table of its own rather than a column on the run, because the
-- carry holds the variants the run's tags and markets cover -- a 100k-variant run's worth -- and
-- every reader of the run history selects the run's row whole.
--
-- Expand only: a new table the previous release neither reads nor writes. Rolled back one
-- version, a run waiting between turns is an EXECUTING run gone quiet to that release's reaper,
-- reclaimed as Partial after five minutes; Resume finishes it, writing only what is unverified
-- (E2). A turn's job carries a `runId` that release's handler finds out of QUEUED and stands
-- down to.
CREATE TABLE "run_chunks" (
    "runId" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "turns" INTEGER NOT NULL DEFAULT 0,
    "waitingSince" TIMESTAMP(3),
    "restarts" INTEGER NOT NULL DEFAULT 0,
    "carry" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "run_chunks_pkey" PRIMARY KEY ("runId")
);

CREATE INDEX "run_chunks_waitingSince_idx" ON "run_chunks"("waitingSince");

ALTER TABLE "run_chunks" ADD CONSTRAINT "run_chunks_runId_fkey" FOREIGN KEY ("runId") REFERENCES "campaign_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
