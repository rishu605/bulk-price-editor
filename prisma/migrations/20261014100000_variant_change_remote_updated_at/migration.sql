-- Shopify's own timestamp for the write a ledger row records: the product's updatedAt,
-- from the mutation's response (#932). The mirror is stamped with it rather than with our
-- read-back time, so a merchant's edit made a second after the write -- on Shopify's
-- clock, to the second -- is never mistaken for a delivery from before it. Expand only:
-- null on older rows, which the mirror falls back to verifiedAt for, as before.
ALTER TABLE "variant_changes" ADD COLUMN "remoteUpdatedAt" TIMESTAMP(3);
