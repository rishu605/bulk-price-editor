-- How far a run's executor has got through the prices it writes, stamped with its heartbeat,
-- so the campaign page can say how long the run has left (#820).
--
-- The run's own counts (`verifiedRows`, `failedRows`) are written at its end, and the sync path
-- settles its ledger rows in one batch once every product is written and read back. So while
-- prices were being written nothing a page could read had moved. The executor reports each
-- product it writes to the heartbeat, which kept only the time; it now keeps the count too, in
-- the same update and under the same throttle.
--
-- Not a plan input. No plan reads them, and the heartbeat writes them every few seconds while a
-- run writes, so the runs' update trigger ignores them beside `heartbeatAt`. Its list is of
-- columns to ignore, so a column added later counts: without this, every stored plan of the
-- shop would read stale for as long as a run lasted. Replaced in one statement, so no update
-- goes unlogged between a drop and a create.
--
-- Expand only: two nullable columns the previous release neither reads nor writes, and a trigger
-- that ignores them. Rolled back one version, the page says no time left, as it did before.

ALTER TABLE "campaign_runs" ADD COLUMN "writtenRows" INTEGER;
ALTER TABLE "campaign_runs" ADD COLUMN "writableRows" INTEGER;

CREATE OR REPLACE TRIGGER "campaign_runs_plan_inputs_update" AFTER UPDATE ON "campaign_runs" REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION "anchor_plan_inputs_updated"('shopId', 'heartbeatAt', 'writtenRows', 'writableRows');
