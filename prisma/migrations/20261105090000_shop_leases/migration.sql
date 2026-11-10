-- One run and one sync per shop at a time, held by the database (#809, D33).
--
-- The worker took jobs in the order Redis held them, two `execution` jobs at once for the
-- whole app, and nothing said two of them were the same shop's. Two 100k-variant runs from one
-- shop held both slots, and every other shop's one-variant sale waited behind them. A shop's
-- run, wherever it runs -- a worker's job, the scheduler's tick with Redis down, a campaign
-- page writing fifty variants -- now holds this row while it writes, and a job that finds it
-- held goes back to wait its turn.
--
-- A lease, not a lock. A session's advisory lock would hold a pooled connection for as long as
-- a run lasts, which is hours on the bulk path and exactly the connection #810 sized the pool
-- without, and PgBouncer's transaction pooling cannot keep one at all. The row is taken with
-- one conditional upsert, renewed while its holder works, and anyone may take it once it has
-- expired: a worker that dies holds its shop for `RUN_STALE_AFTER_MS` at most, which is when
-- the reaper reclaims its run anyway.
--
-- Expand only: a new table, read and written by nothing in the previous release. Rolled back
-- one version, nothing takes a lease, a shop's runs may overlap as they did, and the rows left
-- here expire unread.
CREATE TABLE "shop_leases" (
    "shopId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "holder" TEXT NOT NULL,
    "campaignId" TEXT,
    "acquiredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shop_leases_pkey" PRIMARY KEY ("shopId", "kind")
);

ALTER TABLE "shop_leases" ADD CONSTRAINT "shop_leases_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
