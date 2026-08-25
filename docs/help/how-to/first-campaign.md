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

- **Scope** — leave everything blank to target the whole catalogue, or narrow by collection, vendor, tag or title.
- **Rule** — "percent change from baseline", `-20` for 20% off.
- **Compare-at** — "set to baseline" gives the strike-through shoppers expect.
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
have fifty thousand products and want to build confidence first, start there.
