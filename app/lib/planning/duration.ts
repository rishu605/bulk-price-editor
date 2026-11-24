import { MAX_INLINE_ROWS } from "../execution/inline-budget";
import { countOf, formatCount } from "../format/display";
import type { WritePath } from "./types";

/**
 * How long this run will take, in a sentence, without inventing a rate limit.
 *
 * NA tells a merchant "a price change job like this usually takes a minute or less to
 * complete" before they confirm, and it is one of the more reassuring things in their
 * app. We can do better than a constant, because `selectWritePath` has already made the
 * decision that determines the answer — but only if the answer stays honest, and rule 8
 * says never hardcode a rate limit: shops differ by plan, and the real numbers come from
 * `extensions.cost.throttleStatus` on live responses.
 *
 * So this asserts nothing it has not been told:
 *
 * - **while you wait** only for a run the page writes itself: a campaign of at most
 *   `MAX_INLINE_ROWS` variants (D29). Every larger one is the background worker's since
 *   #808, so "written while you wait, kept under 60 seconds" over 190 variants promised a
 *   wait that never happened -- the press answers at once and the page follows the run.
 * - **one product at a time in the background** for the rest of the sync path: one call per
 *   product at the shop's own rate limit, which this file may not guess at (rule 8), so it
 *   says how it goes rather than how long.
 * - **bulk** costs no rate-limit points and is queued by Shopify FIFO. The dominant term
 *   is queue latency, which is not ours to know. Saying "a few minutes" with confidence
 *   would be the kind of made-up number this file exists to avoid, so it says the shape
 *   of the answer instead.
 *
 * The row count is included because it is the number a merchant is actually checking:
 * "3,669 variants" beside "a minute" is a claim they can sanity-check, and a duration on
 * its own is not.
 *
 * In the merchant's words, not the engine's (#759). The Preview tab printed the planner's
 * own reasoning -- "Write path: sync — 2 rows is under the 1000-row threshold and fits the
 * available rate-limit budget" -- and now says this sentence instead, so "sync", "bulk"
 * and "bulk operation" are said as what they mean to the person waiting: written while
 * they wait, or handed to Shopify to finish in the background.
 */
export function describeRunDuration(
  path: WritePath | "none",
  rowCount: number,
  /**
   * How many variants the campaign covers, written or not: what decides whether the page
   * writes it while it waits (D29). The rows it writes when the caller has no other count.
   */
  scope = rowCount,
): string {
  if (rowCount === 0) return "Nothing would be written.";

  const variants = countOf(rowCount, "variant");

  if (path === "bulk") {
    return (
      `${variants}, handed to Shopify to write in the background. Shopify queues these, so it ` +
      `usually finishes within minutes — but the queue is shared with every other app on your ` +
      `store, and we cannot see how busy it is. You can leave this page; it keeps going.`
    );
  }

  if (scope <= MAX_INLINE_ROWS) {
    return (
      `${variants}, written while you wait. A campaign covering more than ${formatCount(MAX_INLINE_ROWS)} ` +
      "variants is written in the background instead."
    );
  }

  return (
    `${variants}, written in the background one product at a time, each read back as it goes. ` +
    "You can leave this page; it shows how far the run has got, and it keeps going."
  );
}
