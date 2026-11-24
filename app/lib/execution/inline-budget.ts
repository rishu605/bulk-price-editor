/**
 * How much writing one HTTP request can do before its connection is closed -- and, since
 * D29 (#808), how little a run may cover and still be written there at all.
 *
 * `runCampaign` used to run every Apply, Revert and Resume inside the request that asked
 * for it, bounded only by the time it would take. One 102,132-variant apply on anchor-perf
 * then held the web process's whole connection pool for minutes, and every other shop's
 * pages went blank (#803). So a run is the worker's unless it is tiny: at most
 * `MAX_INLINE_ROWS` variants, pressed on the campaign page, still runs where it was asked,
 * so a merchant's one-variant revert and App Review's few-variant apply and revert behave as
 * they always did. Everything else -- and everything Flow starts -- is handed to the worker
 * (`queueRun`), and the page follows it there.
 *
 * Railway's proxy closes a request after five minutes with no data transferred, and a React
 * Router action sends nothing until it returns -- so five minutes is the real ceiling, not
 * the fifteen that applies to a streaming response.
 *
 * **The failure that ceiling causes is the bad kind.** Exceeding it does not cancel the
 * work. The proxy closes the connection while `runCampaign` carries on writing, so the
 * merchant sees a bare "502" and their storefront changes anyway -- the one outcome this
 * product exists to prevent, arriving through a timeout nobody documented.
 *
 * **The time budget stays, beside the rows (#790).** It used to be 120,000 variants, from
 * 1.75 ms a variant measured on `anchor-perf` -- on the bulk path, where 62,535 variants are
 * one mutation and the wait is the whole cost. Two things were never in that figure:
 *
 * - **Shopify's bulk queue.** A run over `DEFAULT_THRESHOLD` variants is submitted as one
 *   bulk operation and polled until Shopify finishes it. The queue is shared with every
 *   other app on the store and is not ours to know, so a bulk-path run has no estimate at
 *   all, and never runs inside a request.
 * - **Per-product calls.** The sync path writes one product per call, and a campaign's
 *   tag kit is one `tagsAdd` per product after that. Both are network round trips,
 *   measured below -- about four hundred times the bulk figure per product.
 *
 * A 3,666-variant campaign passed the old check at 3% of the limit, ran for 7½ minutes,
 * and showed the merchant a bare "502" at five while it kept writing prices and tags. A
 * 522-variant one on 318 products -- under the bulk threshold, so all of it sync -- takes
 * 7 minutes 9 seconds with its tag kit, and this budget estimates it at 7 minutes 1. Under
 * `MAX_INLINE_ROWS` the budget never binds on the page (a test holds that); it is what still
 * bounds a drift put-back's estimate, and it says so if the figures ever move.
 *
 * Above either, the answer is not "no" -- it is "not in this request". The worker has no
 * request attached and no deadline, so the run is handed to it and the page follows the
 * run row until it finishes.
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
 * The most variants a run pressed on the campaign page may cover and still be written inside
 * the request (D29, #808). Larger, and the run is the worker's: a queued run row first, a job
 * second, and the page shows it Queued, then Planning, then Writing N of M, then Verifying.
 *
 * Fifty, because the runs that must keep behaving as they always did are tiny: a merchant's
 * one-variant revert or reinstate, and App Review's apply and revert on a development store's
 * handful of variants. At the measured cost of a product on the sync path, with its tag kit,
 * fifty is about a minute -- inside `PAGE_INLINE_BUDGET_MS`, so the time budget never binds
 * below it -- and fifty rows cannot hold a web connection long enough to starve another shop's
 * pages, which a run of thousands did (#803). Counted as `inlineWork` counts the scope: one
 * indexed count of the campaign's variants, before anything is planned.
 */
export const MAX_INLINE_ROWS = 50;

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
 * It names the size and the reason; the caller adds what happens next. Since D29 that is
 * always the worker: a run is never refused for its size.
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
 * What a caller lets a run do before answering: how many variants it may cover, and how long
 * it may take (D29). Set only by `startRun`, which is the one place a route starts a run.
 */
export interface InlineLimit {
  /** `MAX_INLINE_ROWS` for the campaign page; 0 for a caller that never writes inline. */
  rows: number;
  /** The caller's deadline, in milliseconds. */
  budgetMs: number;
}

/** The campaign page's: fifty variants, and two of Railway's five minutes. */
export const PAGE_INLINE: InlineLimit = { rows: MAX_INLINE_ROWS, budgetMs: PAGE_INLINE_BUDGET_MS };

/** A caller none of whose runs is written inline: Shopify Flow, which waits ten seconds (D29). */
export const NEVER_INLINE: InlineLimit = { rows: 0, budgetMs: 0 };

/**
 * Why this run is handed to the worker rather than written in the request that asked, in a
 * sentence a merchant (or Flow's run log) can read, or null when it runs here (D29).
 *
 * It names the size and the reason; `queueRun` adds what happens next. A caller that never
 * writes inline hands over every run, an empty one included: there is no size at which Flow's
 * ten seconds are the right place to write prices.
 */
export function handedOver(work: InlineWork, limit: InlineLimit): string | null {
  if (limit.rows <= 0) return "Runs started from Shopify Flow are always written by the background worker.";
  // The bulk path and the time first: either says more about the run than its count does.
  const tooLong = overBudget(work, limit.budgetMs);
  if (tooLong) return tooLong;
  if (work.variants > limit.rows) {
    return (
      `This campaign covers ${formatCount(work.variants)} variants, more than the ${formatCount(limit.rows)} ` +
      "Anchor writes while the page waits."
    );
  }
  return null;
}
