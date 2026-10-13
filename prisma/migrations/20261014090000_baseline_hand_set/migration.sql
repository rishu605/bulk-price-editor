-- Whether a market baseline was a price the merchant set by hand on the list, rather than
-- one the list derived from the store price (#930). A revert recomputes a hand-set price
-- and writes it back; it deletes a derived one so the variant follows the store price
-- again. Expand only: null on every row captured before this, which a revert treats as it
-- always has, and a release one version back ignores the column.
ALTER TABLE "baselines" ADD COLUMN "handSet" BOOLEAN;
