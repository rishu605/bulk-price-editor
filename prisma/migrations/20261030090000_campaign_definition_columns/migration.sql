-- What a campaign prices gets columns of its own, out of the `schedule` JSON (#884).
--
-- The blob held when a campaign runs and, beside it, what it prices: the filter (`ast`, and
-- `productStatuses` since #751), `segmentId`, `rounding` and `practice`. Everything that
-- copied or cleared "the schedule" had to know which keys were which; Duplicate did not, and
-- its copies priced the whole catalogue, could be applied though practice, and lost their
-- rounding (#762). `lib/campaigns/schedule-blob.ts` is the convention that fixed it, and the
-- next feature that copies or clears a schedule could still break it.
--
-- Expand only. The release before reads the blob and never these columns, and its inserts
-- leave them at null and false, which every reader takes as "not recorded here" and reads the
-- blob instead. That is why `filter` and `rounding` are nullable rather than defaulting to a
-- value: a default would be indistinguishable from a choice. This release writes both, so a
-- rollback one version back finds every blob as complete as it left it.
--
-- The backfill fills each column from the blob exactly as `model.server.ts` reads the blob,
-- so no campaign prices differently for having been moved:
--   filter     `ast`, or no conditions (every variant) where it is missing or null, without
--              any `productStatuses` of its own -- `astOf` always took the blob's top-level
--              list over it -- and with the blob's `productStatuses` beside the conditions,
--              left out where the blob has none, so the reader's default (active products
--              only) still applies to a campaign from before #751.
--   segmentId  the blob's string, null where there is none.
--   rounding   the blob's value as it is -- a per-currency policy, a bare profile name from
--              before those, or anything else, all of which `parseRoundingPolicy` reads -- and
--              null where there is none, JSON null included, which it reads as no rounding.
--   practice   true only for a JSON `true`, as `isPractice` reads it.
-- An `ast` that is not an object never existed; it is read as no conditions here rather than
-- failing the migration, since taking a key out of a JSON scalar is an error.
--
-- Each column is filled only where it is still at its default, the same rule the readers'
-- fallback follows, so the statement can be run again and changes nothing it filled.
--
-- The contract, a release after this one has shipped, and not before -- the release it rolls
-- back to must be one that reads these columns:
--   1. Run this UPDATE again, in its own migration: a rollback to the release before this one
--      inserts campaigns with the definition in the blob alone.
--   2. Stop writing `ast`, `productStatuses`, `segmentId`, `rounding` and `practice` into
--      `schedule`, and strip them from every blob in the same migration (`"schedule" - 'ast'
--      - ...`). Safe one version back, because this release reads the columns first.
--   3. Drop the readers' fallback, Home's practice count on the blob, and the blob check in
--      `referencingCampaigns`. Delete `schedule-blob.ts`: a copy and an unschedule then
--      take the window keys out by name, or copy no blob at all.
-- `startConfirmed` and `queuedRefused` stay in `schedule` either way: neither the window nor
-- the definition, but the campaign's own record, and moving them is a change of its own.
ALTER TABLE "campaigns" ADD COLUMN "filter" JSONB,
ADD COLUMN "segmentId" TEXT,
ADD COLUMN "rounding" JSONB,
ADD COLUMN "practice" BOOLEAN NOT NULL DEFAULT false;

-- The backfill. A campaign the release before inserts while this runs, or after, is left at
-- the defaults and read from its blob until the contract's backfill fills it.
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
