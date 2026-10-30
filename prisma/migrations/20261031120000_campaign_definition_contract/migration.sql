-- What a campaign prices is read from its columns alone, and the `schedule` JSON stops
-- holding a copy of it (#1141): the contract half of #884's expand/contract move.
--
-- #884 gave the filter (`ast`, with `productStatuses`), `segmentId`, `rounding` and `practice`
-- columns of their own, filled them from the blob, and for one release went on writing the
-- blob's copy and reading it wherever a column was at its default. The copy existed only so
-- that a rollback to the release before #884, which reads nothing else, stayed safe. Until it
-- goes, the next feature that copies or clears "the schedule" can still drop what a campaign
-- prices, which is #762 again. This release stops writing the copy and reads no blob for a
-- definition, so this migration first makes every row's columns the whole truth.
--
-- 1. The backfill again, exactly #884's statement (the chaos scenario `definition-columns`
--    checks the two are the same text). A rollback to the release before #884 -- after its
--    migration ran -- inserts campaigns with the definition in the blob alone and the columns
--    at null and false. #884's readers took those from the blob; nothing after this does, so
--    they are filled here, first, while the blob still says what they price. A column already
--    off its default is left alone, so every row #884's release wrote keeps what it wrote.
-- 2. The copy stripped, in the same migration, once the backfill has read it: what is left
--    in `schedule` is the window and the campaign's own record (`startConfirmed`,
--    `queuedRefused` -- see `lib/campaigns/own-record.ts`), and moving those out is a
--    change of its own. Only objects are touched: a key cannot be taken out of a JSON scalar,
--    and none ever held a definition.
--
-- Rollback-safe one version back. #884's release reads each column first and the blob only
-- where the column is at its default; after step 1 a column at its default is the
-- campaign's answer (no segment, no rounding, not practice), and the blob it would fall back
-- to says nothing, so it reads every campaign exactly as before. It writes the copy again on
-- what it writes, which nothing here reads. A rollback two versions back, to before #884, is
-- not safe after this, and is not a release this one rolls back to.
--
-- No DDL: the columns keep their types and defaults, so the release before needs no other
-- client. A campaign #884's release writes while this deploys, or during a rollback to it,
-- keeps a copy in its blob that nothing reads; this release's unschedule and new dates take
-- only the campaign's own keys forward, and a copy starts from `{ "kind": "manual" }`.
UPDATE "campaigns"
SET
  "filter" = COALESCE(
    "filter",
    (
      (CASE WHEN jsonb_typeof("schedule"->'ast') = 'object' THEN "schedule"->'ast' ELSE '{"groups": []}'::jsonb END)
        - 'productStatuses'
    ) || (
      CASE WHEN ("schedule"->'productStatuses') IS NOT NULL
        THEN jsonb_build_object('productStatuses', "schedule"->'productStatuses')
        ELSE '{}'::jsonb
      END
    )
  ),
  "segmentId" = COALESCE("segmentId", "schedule"->>'segmentId'),
  "rounding" = COALESCE("rounding", NULLIF("schedule"->'rounding', 'null'::jsonb)),
  "practice" = "practice" OR COALESCE(("schedule"->'practice') = 'true'::jsonb, false);

-- The copy, stripped from every blob that still holds any of it.
UPDATE "campaigns"
SET "schedule" = "schedule" - 'ast' - 'productStatuses' - 'segmentId' - 'rounding' - 'practice'
WHERE jsonb_typeof("schedule") = 'object'
  AND "schedule" ?| ARRAY['ast', 'productStatuses', 'segmentId', 'rounding', 'practice'];
