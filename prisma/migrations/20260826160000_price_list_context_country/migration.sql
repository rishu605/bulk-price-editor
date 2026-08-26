-- One country per market price list, for asking Shopify what a shopper there pays.
--
-- `contextualPricing` is keyed by country rather than by price list, and every country in
-- a market sees the same price, so any one region answers for all of them.
--
-- Expand-only: nullable with no default and no backfill. A row without it simply has no
-- contextual price read for it yet, which the next market sync fills in.
ALTER TABLE "price_lists" ADD COLUMN "contextCountry" TEXT;
