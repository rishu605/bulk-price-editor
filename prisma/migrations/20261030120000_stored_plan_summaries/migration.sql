-- Stored plan summaries, and what tells a stored one from a current one (#812).
--
-- The campaign page planned its whole campaign on every load and tab switch: at 102,132
-- variants, 2 min 20 s on an idle server, with every shop's /healthz at 3-5 s meanwhile
-- (#803). A plan's answer is now stored per campaign (`plan_summaries`) and read.
--
-- A stored answer is only worth reading if a stale one can never pass for current, and the
-- answer depends on a dozen tables written from thirty-odd places: syncs, the products
-- webhook, every baseline capture, every campaign edit and transition, the ledger, the
-- drift queue, Settings. A call at each of them would be the one somebody forgets. So the
-- database records it: every statement that writes a table a plan reads logs the shop and
-- its transaction in `plan_input_changes`, and a summary keeps the snapshot it was planned
-- from (`pg_current_snapshot()`, taken before the plan read anything). The summary is
-- current exactly while no logged write of its shop is invisible to that snapshot -- one
-- committed after the plan began, or one still running then. Exact, not a timestamp race: a
-- transaction that wrote before the plan started and committed after it is invisible to the
-- snapshot, so it marks the summary stale, where a watermark of times or ids would miss it.
--
-- Statement-level triggers with transition tables: one log row per shop per statement, and
-- per transaction after the first (the unique index), however many rows the statement wrote.
-- No foreign key on the log: a shop's own deletion cascades through these tables, and a
-- trigger inserting a row that references the shop being deleted would fail the delete.
-- Rows are pruned once older than any summary could still be current (`prunePlanInputChanges`).
--
-- Expand only: two new tables, two functions, triggers that insert into a table nothing in
-- the previous release reads. Rolled back one version, the page plans on every load as it
-- did, the triggers keep logging, and nothing reads the log until this release is back --
-- at which point every summary stored before the rollback is still judged against it.

CREATE TABLE "plan_summaries" (
    "campaignId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "preview" JSONB,
    "rollback" JSONB,
    "keepers" JSONB,
    "snapshot" TEXT,
    "snapshotXmin" BIGINT,
    "computedAt" TIMESTAMP(3),
    "requestedAt" TIMESTAMP(3),

    CONSTRAINT "plan_summaries_pkey" PRIMARY KEY ("campaignId")
);

CREATE INDEX "plan_summaries_shopId_idx" ON "plan_summaries"("shopId");

ALTER TABLE "plan_summaries" ADD CONSTRAINT "plan_summaries_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "plan_summaries" ADD CONSTRAINT "plan_summaries_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "plan_input_changes" (
    "id" BIGSERIAL NOT NULL,
    "shopId" TEXT NOT NULL,
    "xid" BIGINT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plan_input_changes_pkey" PRIMARY KEY ("id")
);

-- The freshness check's range scan -- this shop's writes from the snapshot's xmin on -- and
-- the one row per shop per transaction.
CREATE UNIQUE INDEX "plan_input_changes_shopId_xid_key" ON "plan_input_changes"("shopId", "xid");

CREATE INDEX "plan_input_changes_at_idx" ON "plan_input_changes"("at");

-- A write to a table whose rows carry "shopId": logged for each shop the statement touched.
-- `changed` is the statement's new rows for an insert or update, its old rows for a delete.
-- "at" in UTC, as every timestamp column here holds it, whatever the session's zone.
CREATE FUNCTION "anchor_plan_inputs_changed"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "plan_input_changes" ("shopId", "xid", "at")
  SELECT d."shopId", (pg_current_xact_id()::text)::bigint, (clock_timestamp() AT TIME ZONE 'UTC')
  FROM (SELECT DISTINCT "shopId" FROM changed) d
  ON CONFLICT ("shopId", "xid") DO NOTHING;
  RETURN NULL;
END
$$;

-- An update that counts only when a column other than the ignored ones changed: the shop row's
-- sync progress, stamped every few seconds during a sync, and a run's heartbeat, stamped every
-- few seconds while it writes. Neither is anything a plan reads, and logging them would keep
-- every summary of the shop stale for as long as either lasted. TG_ARGV[0] names the shop's
-- column; the rest are ignored. An ignore-list, not a watch-list: a column added later counts.
CREATE FUNCTION "anchor_plan_inputs_updated"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "plan_input_changes" ("shopId", "xid", "at")
  SELECT d."shopId", (pg_current_xact_id()::text)::bigint, (clock_timestamp() AT TIME ZONE 'UTC')
  FROM (
    SELECT DISTINCT to_jsonb(n) ->> TG_ARGV[0] AS "shopId"
    FROM new_rows n JOIN old_rows o ON o."id" = n."id"
    WHERE (to_jsonb(n) - TG_ARGV) IS DISTINCT FROM (to_jsonb(o) - TG_ARGV)
  ) d
  ON CONFLICT ("shopId", "xid") DO NOTHING;
  RETURN NULL;
END
$$;

-- A campaign's segments, which name no shop: the campaign's.
CREATE FUNCTION "anchor_plan_inputs_campaign_segments"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "plan_input_changes" ("shopId", "xid", "at")
  SELECT d."shopId", (pg_current_xact_id()::text)::bigint, (clock_timestamp() AT TIME ZONE 'UTC')
  FROM (SELECT DISTINCT c."shopId" FROM changed j JOIN "campaigns" c ON c."id" = j."A") d
  ON CONFLICT ("shopId", "xid") DO NOTHING;
  RETURN NULL;
END
$$;

-- An imported file's prices, which name no shop: the import's.
CREATE FUNCTION "anchor_plan_inputs_import_rows"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "plan_input_changes" ("shopId", "xid", "at")
  SELECT d."shopId", (pg_current_xact_id()::text)::bigint, (clock_timestamp() AT TIME ZONE 'UTC')
  FROM (SELECT DISTINCT i."shopId" FROM changed r JOIN "price_imports" i ON i."id" = r."importId") d
  ON CONFLICT ("shopId", "xid") DO NOTHING;
  RETURN NULL;
END
$$;

-- Every table a plan reads (`previewCampaign`, its revert, `rollbackReport`): the catalogue
-- mirror and its live prices, baselines, campaigns and their segments, runs and the ledger
-- (the revert, the rollback report and the market plan read them), held drift, markets,
-- market-wide changes, imported prices, and the store's settings.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'variant_index', 'price_surface_entries', 'baselines', 'segments', 'campaigns',
    'variant_changes', 'drift_events', 'price_lists', 'price_list_changes'
  ] LOOP
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT ON %I REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION "anchor_plan_inputs_changed"()', t || '_plan_inputs_insert', t);
    EXECUTE format('CREATE TRIGGER %I AFTER UPDATE ON %I REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION "anchor_plan_inputs_changed"()', t || '_plan_inputs_update', t);
    EXECUTE format('CREATE TRIGGER %I AFTER DELETE ON %I REFERENCING OLD TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION "anchor_plan_inputs_changed"()', t || '_plan_inputs_delete', t);
  END LOOP;
END
$$;

CREATE TRIGGER "campaign_runs_plan_inputs_insert" AFTER INSERT ON "campaign_runs" REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION "anchor_plan_inputs_changed"();
CREATE TRIGGER "campaign_runs_plan_inputs_update" AFTER UPDATE ON "campaign_runs" REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION "anchor_plan_inputs_updated"('shopId', 'heartbeatAt');
CREATE TRIGGER "campaign_runs_plan_inputs_delete" AFTER DELETE ON "campaign_runs" REFERENCING OLD TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION "anchor_plan_inputs_changed"();

CREATE TRIGGER "campaign_segments_plan_inputs_insert" AFTER INSERT ON "_CampaignSegments" REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION "anchor_plan_inputs_campaign_segments"();
CREATE TRIGGER "campaign_segments_plan_inputs_update" AFTER UPDATE ON "_CampaignSegments" REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION "anchor_plan_inputs_campaign_segments"();
CREATE TRIGGER "campaign_segments_plan_inputs_delete" AFTER DELETE ON "_CampaignSegments" REFERENCING OLD TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION "anchor_plan_inputs_campaign_segments"();

CREATE TRIGGER "price_import_rows_plan_inputs_insert" AFTER INSERT ON "price_import_rows" REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION "anchor_plan_inputs_import_rows"();
CREATE TRIGGER "price_import_rows_plan_inputs_update" AFTER UPDATE ON "price_import_rows" REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION "anchor_plan_inputs_import_rows"();
CREATE TRIGGER "price_import_rows_plan_inputs_delete" AFTER DELETE ON "price_import_rows" REFERENCING OLD TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION "anchor_plan_inputs_import_rows"();

-- The shop row: its settings are the store's guardrails and typed-confirmation thresholds.
-- Not the sync's progress, stamped every two seconds while a sync runs (the catalogue rows it
-- writes are logged anyway), and not the session's token and scopes.
CREATE TRIGGER "shops_plan_inputs_update" AFTER UPDATE ON "shops" REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION "anchor_plan_inputs_updated"('id', 'syncStartedAt', 'syncPhase', 'syncProgress', 'syncHeartbeatAt', 'syncFailure', 'accessTokenEnc', 'scopes');
