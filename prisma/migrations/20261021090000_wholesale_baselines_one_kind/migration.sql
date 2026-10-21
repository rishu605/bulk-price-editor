-- A wholesale price's baselines filed as B2B are superseded (#1071).
--
-- The catalogue sync filed a wholesale catalogue's baselines under the mirror's kind, B2B.
-- Every campaign reads and captures a price list's baseline as MARKET, so none ever priced
-- from one: the campaign captured its own beside it, and a sync during a sale, not seeing
-- that one, baselined the sale price as a B2B row too. What's live counted both. The sync
-- now files them as MARKET and supersedes any B2B one it finds; this puts away the rest.
--
-- Superseded rather than reclassified as MARKET. Some are sale prices, and none recorded the
-- price's quantity ladder, which a baseline the campaign reads must. A price a campaign has
-- priced keeps the MARKET baseline that campaign captured. One no campaign has priced gets
-- its baseline from the next sync, or from the campaign's own capture before it first
-- writes, as it does today. Superseded rows stay as history.
--
-- Data only, and safe one version back: the release before reads no B2B baseline when it
-- prices, and its sync files new ones as it always has.
UPDATE "baselines"
SET "supersededAt" = now()
WHERE "surfaceKind" = 'B2B'
  AND "supersededAt" IS NULL;
