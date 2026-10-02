/**
 * How much writing one HTTP request can do before its connection is closed.
 *
 * `runCampaign` executes inline, so a campaign applied from the campaign page is written
 * by the web process during a single request. Railway's proxy closes a request after
 * five minutes with no data transferred, and a React Router action sends nothing until
 * it returns — so five minutes is the real ceiling, not the fifteen that applies to a
 * streaming response.
 *
 * **The failure it prevents is the bad kind.** Exceeding the ceiling does not cancel the
 * work. The proxy closes the connection while `runCampaign` carries on writing, so the
 * merchant sees a bare "502" and their storefront changes anyway — the one outcome this
 * product exists to prevent, arriving through a timeout nobody documented.
 *
 * **The budget is time, not rows (#790).** It used to be 120,000 variants, from 1.75 ms a
 * variant measured on `anchor-perf` — on the bulk path, where 62,535 variants are one
 * mutation and the wait is the whole cost. Two things were never in that figure:
 *
 * - **Shopify's bulk queue.** A run over `DEFAULT_THRESHOLD` variants is submitted as one
 *   bulk operation and polled until Shopify finishes it. The queue is shared with every
 *   other app on the store and is not ours to know, so a bulk-path run has no estimate at
 *   all, and never runs inside a request.
 * - **Per-product calls.** The sync path writes one product per call, and a campaign's
 *   tag kit is one `tagsAdd` per product after that. Both are network round trips,
 *   measured below — about four hundred times the bulk figure per product.
 *
 * A 3,666-variant campaign passed the old check at 3% of the limit, ran for 7½ minutes,
 * and showed the merchant a bare "502" at five while it kept writing prices and tags. A
 * 522-variant one on 318 products -- under the bulk threshold, so all of it sync -- takes
 * 7 minutes 9 seconds with its tag kit, and this budget estimates it at 7 minutes 1.
 *
 * Above the budget the answer is not "no" — it is "not in this request". The worker has
 * no request attached and no deadline, so the run is handed to it and the page follows
 * the campaign's state until it finishes.
 */

import { formatCount } from "../format/display";
import { DEFAULT_THRESHOLD } from "../planning/write-path";

/** What Railway allows a request with no data transferred. */
export const REQUEST_CEILING_MS = 5 * 60 * 1000;

/**
 * Milliseconds per product on the sync path: one `productVariantsBulkUpdate`, its share
 * of the read-back, and the ledger rows either side.
 *
 * Measured on `boltify-apps`: 108 products (152 variants) applied in 70.1 s in August,
 * about 650 ms a product; 318 products (522 variants) priced in 230 s on 2 Oct, about
 * 725 ms. A product's variants share one call, so this is per product, not per variant.
 */
export const MS_PER_SYNC_PRODUCT = 725;

/**
 * Milliseconds per product the tag kit touches: one `tagsAdd` (or `tagsRemove` on a
 * revert), sequential, with its ledger row written before and after.
 *
 * Measured on `boltify-apps` (2 Oct): 110 products tagged in 67.2 s, about 610 ms each --
 * as much as pricing the product took in the first place.
 */
export const MS_PER_TAGGED_PRODUCT = 600;

/**
 * What the campaign page may spend writing inside its request.
 *
 * Well under the ceiling, not at it: the per-product figures came from one store, a shop
 * being throttled by the Admin API is slower, and planning, read-back and the market
 * surfaces all happen inside the same five minutes.
 */
export const PAGE_INLINE_BUDGET_MS = 2 * 60 * 1000;

/** What a run will do, counted before it starts. */
export interface InlineWork {
  /** Variants in scope. Over `DEFAULT_THRESHOLD` the run takes the bulk path. */
  variants: number;
  /** Products those variants belong to: the sync path writes one product per call. */
  products: number;
  /** Products the tag kit adds to or removes from. Zero for a campaign with no tags. */
  taggedProducts: number;
}

/**
 * Roughly how long the writing takes, or null when it goes to Shopify's bulk queue,
 * whose wait is not ours to estimate.
 */
export function estimateMs(work: InlineWork): number | null {
  if (work.variants > DEFAULT_THRESHOLD) return null;
  return work.products * MS_PER_SYNC_PRODUCT + work.taggedProducts * MS_PER_TAGGED_PRODUCT;
}

/**
 * Why this run cannot finish inside `budgetMs`, in a sentence a merchant can read, or
 * null when it can.
 *
 * It names the size and the reason; the caller adds what happens next, which differs
 * between handing the run to the worker and refusing it.
 */
export function overBudget(work: InlineWork, budgetMs: number): string | null {
  const ms = estimateMs(work);
  const variants = `${formatCount(work.variants)} ${work.variants === 1 ? "variant" : "variants"}`;

  if (ms === null) {
    return (
      `This campaign covers ${variants}, which go to Shopify as one bulk operation. Shopify ` +
      "queues those behind every other app's on your store, and a request cannot wait on a " +
      "queue nobody can see the end of."
    );
  }
  if (ms <= budgetMs) return null;

  const what =
    work.taggedProducts > 0
      ? `pricing and tagging ${formatCount(work.products)} products`
      : `pricing ${formatCount(work.products)} products`;
  return `This campaign covers ${variants}, and ${what} takes ${roughly(ms)} — longer than this request can wait.`;
}

/** "about 40 seconds", "about 3 minutes": never "0 minutes", never false precision. */
function roughly(ms: number): string {
  if (ms < 90_000) return `about ${Math.max(10, Math.round(ms / 10_000) * 10)} seconds`;
  return `about ${Math.round(ms / 60_000)} minutes`;
}

/**
 * The refusal, for a run over budget with no background worker to hand it to.
 *
 * Names the size, the reason and the way forward — the error taxonomy requires all
 * three, and "too large" on its own leaves a merchant with a campaign they cannot run
 * and no idea what to do about it.
 */
export function refuseInline(reason: string): string {
  return (
    `${reason} Started from here, it would be cut off partway through while still writing ` +
    "prices, which is worse than not starting. Schedule it instead: a scheduled campaign " +
    "runs in the background with no time limit, and reports the same result when it finishes."
  );
}
