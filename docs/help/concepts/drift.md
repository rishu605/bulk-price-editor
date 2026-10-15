# What drift means

![The drift page with nothing to review: a heading reading "No drift detected", beside a panel explaining what each of the three choices does.](../images/drift-empty.png)

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

Every drifted price waits for you on **Prices → Drift**, with both numbers side by side:
what the campaign set, and what the storefront shows now. Anything drifted is flagged on
the **What is live** page too.

There are three answers, and the first is the only one that changes anything permanently:

- **Keep the change** — the new price becomes the baseline. Use it when the edit was a
  permanent repricing: every future campaign computes its discount from this number
  instead of the old one. This is the one worth being sure about, and it is the only one
  the page marks as consequential.
- **Put it back** — the campaign writes its own price again now, and reads it back. Use it
  when the edit was a mistake.
- **Leave it for now** — nothing changes and the alert closes. The baseline is untouched,
  so the next campaign still computes from the old price and the edit stands until
  something else changes it.

Nothing is decided for you and nothing expires: a price stays on this page until you
answer.

## Deciding many at once

A bulk edit in Shopify admin, a spreadsheet import or another app repricing during a sale
can drift hundreds of prices in one go. The page filters by **campaign**, by **product**
(title, SKU or variant ID) and by **direction** — raised above the campaign's price, or
lowered below it — and always shows how many match against how many are waiting in all.

Once the matching prices all belong to one campaign, the same three answers are offered
for all of them at once: **Keep all … changes**, **Put all … back** and **Leave all … for
now**. Each asks first, naming the campaign and the count, and covers exactly the prices the
page showed: an edit made after the page loaded is not included. A decision is recorded in
the Activity log as one entry listing every variant it covered.

- **Put them all back** writes every price in one run for the campaign, read back like any
  other, so the campaign's Runs and Ledger tabs show it. A price Shopify does not confirm
  stays here for another try.
- **Keep them all** leaves out any edit the storefront no longer shows, since there is no
  change left to keep.
- More than a thousand at a time, or a put-back too long to wait for, runs in the
  background; the page shows how far it has got, and you can leave it.

**Export all … drifted prices** downloads every price the filters match as a spreadsheet,
not only the ones on screen.

When you revert a campaign, drifted products are listed separately with a tick box, so
ending a sale never silently discards a price you set on purpose.

## Drift versus off baseline

Different things, easily confused:

- **Off baseline** means the price differs from its normal price. That is what a sale *is*. Expected.
- **Drifted** means the price differs from what *we* wrote. That is somebody else's change.

A product on sale is off baseline and not drifted. A product on sale that somebody then
edited by hand is both.
