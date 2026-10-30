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

/**
 * How many Shopify reads the recapture page makes for wholesale quantity ladders while the
 * merchant waits (#1105). A recapture needing more is handed to the worker, and the page
 * follows it there step by step, as Home follows a sync.
 *
 * A wholesale price is recaptured with its quantity ladder or not at all, and the ladder is
 * read from Shopify, 25 prices a read (`LADDER_READ_VARIANTS`), one read after another --
 * before a single baseline is written. Flow's four reads take a second or two
 * (`FLOW_INLINE_LADDER_READS`): about half a second a read on a Plus store, whose bucket and
 * restore rate leave a read of this cost unthrottled, and B2B catalogues are a Plus feature.
 * Forty reads, a thousand wholesale prices, is then about twenty seconds. Even at three times
 * that pace it is half of `PAGE_INLINE_BUDGET_MS`, which leaves the other half for what the
 * same request does around the reads: counting the scope against every running campaign, and
 * writing a baseline for every surface in it. Not measured on a store with a large wholesale
 * catalogue; inferred from Flow's figure, and set low because the cost of being wrong is
 * lopsided -- a recapture sent to the worker that could have run here costs a few seconds of
 * polling, and one kept here that could not is a "502" over a recapture still writing.
 *
 * Reads rather than prices, because reads are what take the time: a list of three prices
 * costs a read as one of twenty-five does. Counted as Flow counts them, by
 * `ladderReadsToCapture`.
 */
export const PAGE_INLINE_LADDER_READS = 40;

/**
 * The largest scope the campaign page plans while it loads, when it has no current stored
 * plan to read (#812). Larger, and the plan is handed to the worker and the page shows the
 * last numbers it has -- or says one is being worked out -- until the worker's plan arrives.
 *
 * A plan's cost grows with the scope: 2 min 20 s for 102,132 variants on an idle server
 * (#803), about 1.4 ms a variant, every candidate, baseline and market price read. The page
 * is meant to answer in under 1.5 s at p95, so the plan inside it has to fit with room for
 * the rest of the loader: 500 variants is about 0.7 s at that rate. Inline below it, because
 * a small campaign planned while the page loads is current the moment it is shown, where one
 * handed to the worker is "being worked out" for the seconds a job takes to be picked up --
 * and the small campaigns are most of them.
 *
 * Counted by `scopeSize`, one indexed count, never from a stored summary's own numbers: a
 * stale one that said 300 for a scope a catalogue import took to 102,132 would plan the very
 * campaign this exists to keep out of the page.
 */
export const PAGE_INLINE_PLAN_VARIANTS = 500;

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
