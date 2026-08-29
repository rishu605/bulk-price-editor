import { formatCount } from "../format/display";
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
 * - **sync** is *defined* as a run that fits inside `maxSyncSeconds` — `selectWritePath`
 *   switches to bulk precisely when it would not. "Under a minute" is therefore a
 *   property of the decision that was made, not a guess about a shop's bucket.
 * - **bulk** costs no rate-limit points and is queued by Shopify FIFO. The dominant term
 *   is queue latency, which is not ours to know. Saying "a few minutes" with confidence
 *   would be the kind of made-up number this file exists to avoid, so it says the shape
 *   of the answer instead.
 *
 * The row count is included because it is the number a merchant is actually checking:
 * "3,669 variants" beside "a minute" is a claim they can sanity-check, and a duration on
 * its own is not.
 */
export function describeRunDuration(
  path: WritePath | "none",
  rowCount: number,
  /** Seconds a sync run is allowed to take. Mirrors `selectWritePath`'s ceiling. */
  maxSyncSeconds = 60,
): string {
  if (rowCount === 0) return "Nothing would be written.";

  const variants = `${formatCount(rowCount)} ${rowCount === 1 ? "variant" : "variants"}`;

  if (path === "bulk") {
    return (
      `${variants}, sent as one bulk operation. Shopify queues these, so it usually ` +
      `finishes within minutes — but the queue is shared with every other app on your ` +
      `store, and we cannot see how busy it is. You can leave this page; it keeps going.`
    );
  }

  return (
    `${variants}, written directly. Runs of this size are kept under ` +
    `${maxSyncSeconds} seconds — anything larger is sent as a bulk operation instead.`
  );
}
