# Running a sale across several markets

A campaign can price into your markets alongside your base price, with a real
strike-through in each market's own currency.

## Each market is priced from its own normal price

This is the part that is easy to get wrong and that most tools do get wrong.

If your European market normally sits 10% below your base price, a 20% sale there means
20% off the *European* price — not the euro equivalent of your base sale price. The two
are different numbers, and the second one quietly changes your European margin every time
your base price moves.

The app computes each market from that market's own baseline, through the same rule.

## Currencies round differently

`.99` is what a shopper in dollars reads as a considered price. Yen has no sub-unit for a
`.99` ending at all.

Set rounding per currency in **Settings → Rounding**, or per campaign in the wizard. A
currency with no decimal places gets sensible whole-number rounding rather than an ending
it cannot express.

## Reading the preview

The preview shows one column per market, so you can see the base price, the euro price and
the yen price for the same product side by side. That is the view that catches a market
rounding to something strange.

## Reverting

Removes the campaign's prices from every market it touched. A market that normally derives
its prices as a percentage goes back to doing that, rather than being pinned to numbers you
never chose.
