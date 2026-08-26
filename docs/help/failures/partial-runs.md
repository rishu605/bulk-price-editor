# Understanding a partial run

![The "What is live, and why" page: 3,696 rows, a green banner reading "Every price we have written is still exactly what we wrote. 6 are away from their baseline, which is what a running campaign looks like.", and filters for title, surface, controlling campaign and what to show.](../images/what-is-live.png)

A run is **partial** when some products were priced and some were not.

This is a normal outcome, not a crash. Shopify rate-limits, a product gets deleted
mid-run, a variant is rejected — on a large catalogue something eventually goes wrong, and
the honest response is to say so rather than to report success and hope.

## What partial guarantees

- Every product that was written is recorded, with the price we wrote.
- Every product that was not is recorded, with the reason.
- Nothing is half-written. A price either changed and was read back and confirmed, or it did not change.

## What to do

Open the campaign and read the ledger. Each unfinished row says why.

**Resume** picks up exactly where it stopped. It does not replan and it does not rewrite
products that already succeeded, so resuming is safe however many times you do it.

If the reason was a deleted product or a rejected variant, resuming will not help those
rows — fix the product in Shopify first, or exclude it.

## Why the campaign says "partial" rather than "active"

Because it is. A campaign showing ACTIVE means every product it covers is at its campaign
price. If some are not, saying ACTIVE would be a lie, and every decision you made on the
strength of it would be built on that lie.

## Related

- [Why revert recomputes](../concepts/revert.md)
- [When Shopify is unreachable](./shopify-unreachable.md)
