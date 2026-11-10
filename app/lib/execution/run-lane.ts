/**
 * Which lane a run goes on in the worker: the small-run lane, or everything else (#809).
 *
 * The `execution` lane takes runs in the order they came, two at once across every worker.
 * One 100k-variant sale holds a slot for as long as Shopify's bulk queue takes -- an hour is
 * not unusual -- so with two shops' large runs writing, a third shop's one-variant revert used
 * to wait for one of them to finish. The small-run lane has slots of its own that a large run
 * never takes, so a run a merchant is sitting in front of starts in seconds whatever else is
 * writing.
 *
 * **Small is time, not rows.** #809 suggested about 1,000 rows. The inline budget's own
 * measurements put 1,000 variants on the sync path at ten to twenty minutes with a tag kit
 * (`MS_PER_SYNC_PRODUCT`, `MS_PER_TAGGED_PRODUCT`), so two such runs would hold the lane a
 * one-variant revert is meant to find free. A run is small when those figures say its writing
 * takes `SMALL_RUN_MS` or less: about ninety tagged products, or a hundred and sixty untagged.
 * A run on Shopify's bulk queue has no estimate at all (`estimateMs`), and is never small.
 */

import { estimateMs, type InlineWork } from "./inline-budget";

/**
 * The most writing a run may be estimated at and still go on the small-run lane: two minutes,
 * what the campaign page itself can wait for (`PAGE_INLINE_BUDGET_MS`, which a test holds it
 * to). A one-variant run on a busy lane waits behind at most this much of another shop's,
 * rather than behind a sale of any size. A number of its own rather than that one read when
 * this module loads, so nothing that stands in for the page's budget moves the lanes.
 */
export const SMALL_RUN_MS = 2 * 60 * 1000;

/** Whether a run of this size goes on the small-run lane. */
export function smallRun(work: InlineWork): boolean {
  const ms = estimateMs(work);
  return ms !== null && ms <= SMALL_RUN_MS;
}

/**
 * The same for a run over named variants, whose products are not counted: an enrolment's newly
 * scoped variants. Each is taken as its own product, which over-counts a product with several
 * and so errs toward the large lane, never toward holding up the small one.
 */
export function smallVariantRun(variants: number, tagged: boolean): boolean {
  return smallRun({ variants, products: variants, taggedProducts: tagged ? variants : 0 });
}
