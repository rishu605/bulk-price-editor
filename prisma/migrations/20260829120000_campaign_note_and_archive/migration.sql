-- A note on a campaign, and archiving instead of deleting.
--
-- Expand only, and both columns are nullable with no default, so the previous release
-- writes rows this schema accepts and this release reads rows that release wrote. Adding
-- a nullable column takes no table rewrite in Postgres 11+; the index build is the only
-- part that takes a lock, and campaigns is a small table on every shop we have seen
-- (thousands, not millions).
--
-- Why archiving is a timestamp and not a `CampaignStatus`:
--
-- `status` answers "could this campaign's prices be live right now" -- `PRICES_MAY_BE_LIVE`
-- reads it, the scheduler reads it, and the revert path reads it. Filing a finished
-- campaign away is not an answer to that question. An ARCHIVED status would force every
-- transition in `LEGAL` to say what archiving means for it, and would make the state
-- machine lose the information it had: a partial run that is archived is still partial,
-- and hiding that behind a filing decision is exactly the kind of quiet loss this app
-- exists to prevent.
--
-- Deliberately NOT in this migration: any change to the `ON DELETE CASCADE` from
-- campaign_runs to campaigns. Deleting a campaign today cascades to its runs and from
-- there to variant_changes -- the ledger, which invariant I4 requires to exist before
-- anything is written to a storefront. Tightening that to RESTRICT looks right and is
-- not: the shop/redact compliance webhook deletes a Shop, and every one of these tables
-- cascades from Shop too, so a RESTRICT here can abort a GDPR erasure depending on the
-- order Postgres processes the referencing tables in. The app offers no campaign delete
-- at all, and `delete-guard.test.ts` keeps it that way.
ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "note" TEXT;
ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "campaigns_shopId_archivedAt_idx" ON "campaigns" ("shopId", "archivedAt");
