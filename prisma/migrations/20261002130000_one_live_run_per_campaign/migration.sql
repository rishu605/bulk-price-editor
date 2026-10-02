-- One writer per campaign, enforced by the database (#793).
--
-- A run row's uniqueness was per occurrence: (campaign, occurrenceKey, kind). That stops a
-- duplicate scheduler tick, whose occurrence is the window it is applying. A press of
-- Apply, a Flow resend, a second tab each take the current instant as their occurrence,
-- so they never collided -- and two whole-campaign runs wrote the same rows at once, two
-- bulk operations and two tag syncs, the last to finish deciding what the storefront kept.
--
-- At most one non-terminal whole-campaign run per campaign. Runs over named variants
-- ("VARIANT-..." occurrences) are left out: they never hold the campaign's claim, and
-- #763's two-sided check keeps them and a whole-campaign run apart.
--
-- Expand only: a unique index changes no rows. The previous release never creates a
-- second live run on purpose, so it does not hit it except in exactly the race this
-- closes, where it now gets the error it already handles for a taken occurrence.
CREATE UNIQUE INDEX "campaign_runs_one_live_run"
  ON "campaign_runs" ("campaignId")
  WHERE "status" IN ('PLANNING', 'QUEUED', 'EXECUTING', 'VERIFYING')
    AND "occurrenceKey" NOT LIKE 'VARIANT-%';
