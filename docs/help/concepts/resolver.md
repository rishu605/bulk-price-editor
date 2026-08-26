# How overlapping campaigns resolve

Two campaigns can cover the same product. They never stack.

## One winner per product

For each product, exactly one campaign controls the price. The winner is:

1. The campaign with the **highest priority**.
2. If two have the same priority, the one that **started most recently**.

Everything else is ignored for that product — not applied on top.

![How a live price is computed: the baseline and every campaign covering a variant go into the resolver, which picks one winner by priority. The £100 baseline with a winning 20% campaign gives a £80 live price; the other two campaigns are ignored rather than added on top.](../images/resolver.svg)

## Why not stack?

Because stacking is how merchants end up giving away 60% by accident. Two 20% campaigns
and a 30% clearance are, stacked, a 55% discount that nobody chose. Every merchant who has
lost money to a pricing app has lost it this way.

If you *want* a deeper discount on some products, that is a campaign with a higher priority
and a bigger number — a thing you decided, visible in one place.

## Seeing it before it happens

The preview on a campaign shows the price each product will get, having already resolved
every other running campaign. What the preview says is what the run does; they share the
same code path, so a preview that disagreed with the run would be a bug rather than an
approximation.

The **calendar** shows which campaigns overlap in time and how many products they share.

## What happens when a campaign ends

The winner is recomputed without it. If a lower-priority campaign still covers the product,
its price applies. If none does, the product returns to its baseline.

That is why reverting is a recomputation rather than a restore — see
[Why revert recomputes](./revert.md).
