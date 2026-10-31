-- A campaign's count of baselines recaptured at its own sale price, where the campaigns list,
-- Home and the calendar can read it (#1166).
--
-- #781 flagged such a campaign on its own page, from its plan. Every other surface showed it as
-- plain Active, and the list's "Needs a decision" filter, being by state, could not find it.
-- Those surfaces read one query per page and cannot plan, so the count is kept beside the
-- stored plan: written when the campaign is planned, and when a recapture, a baseline import
-- or an apply could have changed it.
--
-- On `plan_summaries`, which has no plan-input trigger: writing the count must not make the
-- plan stored beside it stale. `recapturedCountedAt` is when the count began, so an older
-- count never overwrites a newer one.
--
-- Expand only: two nullable columns nothing in the previous release reads. Rolled back one
-- version, the list shows such a campaign as Active again, as it did before.

ALTER TABLE "plan_summaries" ADD COLUMN "recapturedAtSale" INTEGER;
ALTER TABLE "plan_summaries" ADD COLUMN "recapturedCountedAt" TIMESTAMP(3);
