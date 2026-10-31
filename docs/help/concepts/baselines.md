# What a baseline is

A **baseline** is the price a product would be if no campaign were running. Every campaign
computes from it — never from what the storefront happens to show right now.

That one sentence is the whole product.

## Why it matters

Suppose a jacket normally sells for £100 and you run 20% off. It becomes £80.

Now suppose next week you run another 20% off, because the first sale is still on and you
forgot. An app that computes from the *current price* gives you £64. You have accidentally
discounted 36%. Do it a third time and you are at £51.

Anchor computes from the baseline, so the second campaign gives you £80 again. Running a
campaign twice does nothing the second time. This is also what makes reverting exact: we
know what £100 was, because we wrote it down before we touched anything.

## Where baselines come from

- **At install**, we capture whatever your storefront currently shows.
- **You can import them**, if you keep a list price or MSRP somewhere else. This is the right move if your storefront prices are already discounted — otherwise "20% off" means 20% off a sale price.
- **New products** get a baseline captured when they first enter a campaign's scope.

## When to recapture

Recapture when your *normal* prices have genuinely changed — a supplier price rise, a new
season.

A recapture replaces only the baselines that have changed. A product whose storefront price
is already its baseline keeps the baseline it has, and the recapture counts it as already
correct, so its history gains no new entry.

Do **not** recapture while a campaign is running. You would be recording the sale price as
the new normal, and every future discount would come off the discounted number. The app
asks you to type a confirmation for exactly this reason, and tells you which campaigns are
live at the time.

The running campaign is affected too. Its baseline is now its own sale price, so:

- **Its status says so.** It reads *Active — needs a decision* rather than *verified*, on its
  own page and wherever campaigns are listed: the campaigns list and its *Needs a decision*
  filter, Home's *Need attention* count, and the calendar.
- **Applying it again asks first.** A second apply would take the discount off the sale
  price, so 20% off £100 becomes £64 rather than £80. The app asks you to type *apply*, and
  says which product would be discounted again.
- **Reverting it leaves the sale price.** The Revert tab says which products revert to a
  different price from the one the ledger recorded before the campaign, and what that
  price was.

The same goes for a price in a market or a wholesale catalogue the campaign prices. The
recapture records the campaign's price there as one you set by hand, so applying again would
discount it a second time, and reverting would write the sale price back on the list.

Except where the list worked that price out from your base price before the sale, with no
price of its own set there. Reverting then removes the sale's price from the list, so it
follows your base price again, and the next campaign there reads the list's own price from
Shopify before changing it.

To end the sale at the old price, import that price as the baseline (Prices → Baselines),
then revert. An import sets the base price only, so for a market or wholesale price, revert
first, then set the old price on the list in Shopify and recapture its baseline.

Once you revert the campaign, the decision is made. If you apply it again later, it starts a
new sale from the price you kept, and nothing asks about the old one.

A wholesale price is recaptured with its quantity breaks, which are read from Shopify first.
When a scope has more wholesale prices than the page can read while you wait, the recapture
runs in the background once you have confirmed it: the page says which step it is on and how
far it has got, and you can leave it. If a campaign goes live on the scope, or the scope
changes, before it starts writing, nothing is recaptured and the page says why.

## Related

- [Why revert recomputes](./revert.md)
- [Importing your own prices](../how-to/import-baselines.md)
