# RFC-002 — Discount-mode campaigns via Shopify Functions

**Status: design only. Not implemented, deliberately.**

The ticket (#179) gates implementation on ≥30% of paying merchants asking for it in
interviews, and says in as many words: do not build on speculation. There are no paying
merchants yet, so no code exists.

This document is the other acceptance criterion — the multiplexing design — written now
because the constraint that shapes it is knowable today, and because the decision that
matters is one you want settled before somebody is waiting on it.

---

## What it is

Run a campaign as an automatic discount rather than by rewriting base prices. The
storefront shows the reduced price at checkout; the product's own price never changes.

For merchants who cannot touch base prices at all — because a product feed reads them,
because SEO structured data quotes them, because an ERP treats Shopify's price as
authoritative and will overwrite anything else.

## The constraint that shapes everything

**A store allows roughly five active app-based automatic discounts.** The figure of 25 in
some documentation applies to manually created discounts, not app ones.

This is not a limit you design around; it is a limit that decides the architecture. Five
means one function per campaign is not a design, it is a product that stops working on
the sixth sale. And a merchant running seasonal campaigns across several collections is
past five before they have thought about it.

So: **one function, serving every discount-mode campaign, with the selection logic
inside it.**

## The multiplexing design

### Configuration

The function carries one metafield holding every active discount-mode campaign for the
shop, as a compact list:

```
[
  { id, priority, startAt, endAt, rule, variantIds | collectionIds },
  …
]
```

Written by the worker on the same triggers that would otherwise write prices: campaign
start, campaign end, scope change. The web process does not write it, for the same reason
it does not write prices.

### Selection, at runtime

The function receives the cart and, for each line, must answer the same question the
resolver answers today: **which campaign controls this variant?**

The answer must be identical to the price-rewrite path. Two different implementations of
"highest priority wins, ties broken by most recent start" would eventually disagree, and
the disagreement would surface as a merchant seeing one price in the preview and another
at checkout — which is worse than either mode being wrong on its own, because it destroys
trust in both.

**Therefore:** the winner-selection logic is extracted from `app/lib/pricing/resolver.ts`
into a form the function can use, and the function calls it. Not reimplemented in Rust
against the same rules; *shared*. If that proves impossible within the function runtime's
constraints, the fallback is to precompute the winner per variant at write time and ship
the function a flat map — losing the ability to handle a cart-time condition, which is a
price worth paying to keep the two paths in agreement.

### Budget

The metafield is size-limited, and a campaign scoped to 40,000 variants cannot list them.
Scope is therefore expressed as collections and tags where possible, with a variant list
only for frozen segments small enough to fit. A campaign too large to express is refused
**at the point the merchant chooses discount mode**, with the reason — not at run time,
when they have already committed to it.

## Code stacking

RUBIX's users specifically praise its ability to stop discount codes stacking on sale
items, and it is genuinely rare.

In discount mode this is natural: the same function that applies the campaign discount can
decline to combine with a code. In price-rewrite mode it is not available at all — the
price *is* the price, and a code applies on top of it by definition.

That asymmetry is worth stating plainly to the merchant rather than hiding, because it is
one of the few places where discount mode is strictly better.

## The trade-off, as merchants must hear it

Both modes will exist, usable in the same store on different campaigns. The choice is not
obvious and the app should not pretend it is:

| | Price rewrite | Discount mode |
|---|---|---|
| Google Shopping and product feeds | Shows the sale price | **Shows the full price** |
| Storefront sort and filter by price | Uses the sale price | **Uses the full price** |
| Product page price | Sale price | Full price, discounted at checkout |
| Base prices touched | Yes | No |
| Can block discount codes stacking | No | **Yes** |
| Number of concurrent campaigns | Unlimited | About five |

The first two rows are the ones that cost money and the ones merchants do not anticipate.
A sale invisible to Google Shopping is a sale that does not attract the traffic it was run
to attract, and "why did my sale get no clicks" is a support conversation that starts a
week too late.

**So the app should recommend price-rewrite mode by default**, and offer discount mode with
that table in front of the merchant rather than behind a link.

## What would change in the campaign model

Nothing. Same scope, same rule, same schedule, same guardrails, same preview. A campaign
gains an execution mode, and the run path branches on it at the point where it would
otherwise write prices.

That is the property to protect through implementation. If discount mode starts needing
its own scope model or its own rule kinds, the design has gone wrong.

## Open questions for when the gate opens

- Can the resolver's winner selection genuinely be shared with the function runtime, or does the fallback precomputed map become the design?
- What happens to a discount-mode campaign when a merchant hits the five-discount limit through some other app? The function is ours, but the limit is the store's.
- Does the ledger record a discount-mode campaign as having "written" anything? It changes what a shopper pays without changing a price, and the reconciliation view is built around live prices. Probably a separate surface kind, and worth deciding before it is a migration.
