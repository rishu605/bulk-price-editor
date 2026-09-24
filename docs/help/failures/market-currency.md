# A market answered in the wrong currency

Anchor asks Shopify what a shopper in each market pays, and takes that as the baseline for
that market. Occasionally a market answers in the **store's** currency instead of its own —
a Canadian market quoting USD, say.

Every one of those numbers is wrong by an exchange rate. A price that is wrong by a
conversion does not look wrong: it is a plausible number in the right shape, and it would
sit on the storefront until somebody noticed the margin.

So Anchor refuses that market rather than pricing it.

## What was and was not changed

**Only the named market was skipped.** Every other surface — your base prices, your other
markets, any B2B catalogues — was priced normally. The campaign is not half-applied; the
one market that could not be trusted was left exactly as it was.

## How to fix it

1. In the Shopify admin, go to **Settings → Markets**.
2. Open the market named in the message.
3. Check that its currency is the one you expect, and that it is not set to use the
   store's currency.
4. Run the campaign again.

The market is priced on the next run once Shopify answers in the market's own currency.

## Why Anchor does not just convert it itself

It could multiply by an exchange rate, and that is the tempting fix. It would also be a
guess: the rate would be ours rather than Shopify's, it would drift between the moment we
computed it and the moment a shopper loaded the page, and the price on the storefront would
no longer be one Shopify agreed to.

Refusing is the honest answer, and the market is the only thing that had to wait.
