-- The market baselines a catalogue sync captured are hand-set prices, and now say so (#1064).
--
-- The sync captures baselines over the whole mirror, and a market list's rows in the mirror
-- are its fixed prices and nothing else. It never set "handSet", so a revert treated each one
-- as derived and deleted the merchant's own price (#930). The capture sets it now; this marks
-- the rows it wrote before.
--
-- Only rows provably from the sync: INSTALL_CAPTURE and RECAPTURE are written by nothing else
-- on a market. A null AUTO_ENROLL row is left alone -- a campaign wrote those before #930,
-- for derived prices as well as hand-set ones, and nothing on the row tells them apart.
--
-- Data only, and safe one version back: the release before this reads "handSet" = true the
-- same way, and puts these prices back too.
UPDATE "baselines"
SET "handSet" = true
WHERE "surfaceKind" = 'MARKET'
  AND "priceListGid" <> ''
  AND "handSet" IS NULL
  AND "source" IN ('INSTALL_CAPTURE', 'RECAPTURE');
