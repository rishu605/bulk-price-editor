# What drift means

**Drift** is when a price on your storefront is not what this app last wrote.

It is not an error, and it is usually not a problem. It means somebody or something else
changed the price: you edited it in Shopify admin, another app touched it, or a bulk import
ran.

## Why we track it

Because the alternative is worse. If we ignored manual edits, the next revert would
overwrite them without asking — and a merchant who deliberately repriced one product would
find the app had quietly undone it. If we overwrote silently in the other direction, the
app's own ledger would be lying about what is live.

So drift is surfaced and you decide.

## What to do about it

On the **What is live** page, anything drifted is flagged with both numbers: what we wrote
and what is there now.

- **Keep the change** — the app adopts the new price and stops flagging it.
- **Put it back** — the app rewrites what the campaign says it should be.

When you revert a campaign, drifted products are listed separately with a tick box, so
ending a sale never silently discards a price you set on purpose.

## Drift versus off baseline

Different things, easily confused:

- **Off baseline** means the price differs from its normal price. That is what a sale *is*. Expected.
- **Drifted** means the price differs from what *we* wrote. That is somebody else's change.

A product on sale is off baseline and not drifted. A product on sale that somebody then
edited by hand is both.
