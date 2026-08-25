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

Do **not** recapture while a campaign is running. You would be recording the sale price as
the new normal, and every future discount would come off the discounted number. The app
asks you to type a confirmation for exactly this reason, and tells you which campaigns are
live at the time.

## Related

- [Why revert recomputes](./revert.md)
- [Importing your own prices](../how-to/import-baselines.md)
