# Your first campaign

Fifteen minutes, and nothing touches your storefront until you say so.

## 1. Check your baselines

Open **Baselines**. These are the prices every campaign will compute from — captured when
you installed the app.

**If your storefront prices are currently discounted**, stop and
[import your real prices](./import-baselines.md) first. Otherwise "20% off" will mean 20%
off a sale price, permanently.

## 2. Create a campaign

**Campaigns → New campaign.**

- **Scope** — with no conditions it covers every active product. **Add a condition** to narrow it by collection, tag, vendor, product type, status, title, SKU or barcode, stock, or whether a cost is recorded; pick several values to mean any of them. Every condition in a group must hold, and **Or another group** adds a second set any product may match instead. **Add products** puts products you pick into the sale whatever the conditions say, and **Leave products out** keeps them out of it. The count under the conditions is what the preview prices. Draft and archived products are left out unless you tick **Include draft products** or **Include archived products**: a draft you publish mid-sale would otherwise go live at the sale price, and an archived product would come back already discounted.
- **Rule** — "percent change from baseline", **Reduce by** `20` for 20% off. A rule can also price from each variant's cost (**From cost, times a markup** or **at a margin**) or take a percentage off its compare-at price. A variant without the cost or compare-at a rule needs keeps its price, and the preview says how many.
- **Compare-at** — "set to baseline" gives the strike-through shoppers expect. If a new price would reach the strike-through, the campaign drops it by default; you can choose to leave those variants at their price, or to stop the campaign instead.
- **Rounding** — `.99` endings if you want them.

## 3. Read the preview

This is the step that matters. The preview shows the price every product will get, having
already resolved any other campaign that covers it. What it shows is what the run does.

Look at the counts: planned, already correct, skipped, clamped. A large skipped count
usually means a guardrail is doing something you did not expect.

## 4. Apply

Prices are written and then read back and confirmed. When it finishes, the campaign says
how many were verified.

## 5. Reverting

One button. It recomputes what each price should be with this campaign removed — which is
not always the price it was before, and that is deliberate. See
[why revert recomputes](../concepts/revert.md).

## Try it without the risk

A **practice campaign** does everything above and refuses to write anything, ever. If you
have fifty thousand products and want to build confidence first, start there. When the
preview is what you want, **Make a real copy** on its page: a new draft with the same scope
and rule, which you can apply. The practice campaign stays as it is.
