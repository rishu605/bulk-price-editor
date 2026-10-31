# Why revert recomputes

Reverting a campaign does not restore the prices that were there before. It works out what
the price *should* be now, with that campaign removed, and writes that.

## Why not just put the old prices back?

Because the old price is often wrong by the time you revert.

Say a jacket was £100, your summer sale made it £80, and while that ran you started a
clearance campaign that made it £70. Now you end the summer sale. Restoring "what it was
before summer" gives £100 — but clearance is still running, and that product should be £70.

Recomputing gives £70. It is the only approach that survives overlapping campaigns,
recurring campaigns, and campaigns that ended in a partial state.

## What this means in practice

- **Ending a sale is safe** even if other campaigns are running.
- **Reverting a partial run** works: the ledger knows which products were actually written, so only those are touched.
- **Reverting one product** out of a campaign takes it out for good, including future scheduled runs, and recomputes its price without it.

## If someone changed a price by hand

The revert notices. A product whose live price is not what we wrote is reported as
**drifted**, and you choose: keep the manual edit, or bring it back in line. We never
silently overwrite a price a person set — but we never silently ignore it either, because
that would leave a product that no longer matches what the app believes.

A product whose live price is already what reverting would write is not drifted, and the
revert asks nothing about it. That is usually a higher-priority campaign that took the
product over: its price is live, and it stays when this campaign ends. The report lists such
a product as **Already there**.

## If the baseline changed during the sale

Reverting writes the baseline, so a baseline that changed while the sale ran is the price
the product goes back to. Usually that is what you want: a supplier price rise imported
mid-sale should be the new normal price. It is not what you want when the baseline was
recaptured during the sale, because the recapture recorded the sale price as normal.

So the Revert tab and the Revert dialog say when a product will revert to a different
price from the one the ledger recorded before this campaign, and name it: "reverts to
80.00, not 100.00". When the reason is a recapture at the sale price, they say that too.
To put the old price back, import it as the product's baseline first
([Importing your own prices](../how-to/import-baselines.md)), then revert. The
export of the rollback report gives that price for every such product, in its
`before_campaign` column.

A market or wholesale catalogue price recaptured during the sale is said separately, with
the market's name: "reverts to €40.00, not €50.00". Reverting writes a market's baseline back,
so the sale price stays on the list. An import cannot set a market's price, so revert, then
set the old price on the list in Shopify and recapture its baseline. The export lists base
prices only.

## A product another campaign handed over

The other way round works too. When a higher-priority campaign ends, its revert puts this
campaign's price on the products they shared, and from then on those products are this
campaign's: an edit to one is drift on this campaign, and reverting this campaign takes its
price back off them — even if a product has been archived since, so this campaign no longer
covers it.

## Related

- [What a baseline is](./baselines.md)
- [What drift means](./drift.md)
- [Understanding a partial run](../failures/partial-runs.md)
