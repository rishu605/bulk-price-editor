import type { Money } from "../money/money";

/**
 * The storefront's price, but only when it disagrees with the baseline.
 *
 * A campaign's arithmetic starts from the baseline, and almost always the baseline is
 * also what the storefront says — so showing both would put a second identical number in
 * every row of the preview and teach a merchant to ignore the column.
 *
 * When they disagree, the variant is either mid-campaign or has drifted, and the merchant
 * is about to read "40.00 becomes 32.00" beside a storefront showing 28.00. Saying which
 * number the app is working from is the whole difference between our preview and one
 * computed off live values.
 *
 * Currency is compared as well as amount, and a mismatch counts as a disagreement rather
 * than throwing. `equals` would throw `CurrencyMismatchError`, which is right for
 * arithmetic and wrong here: a preview is the last place that should crash rather than
 * report, and two currencies on one surface is itself something to show.
 */
export function liveIfDrifted(
  baseline?: Money | null,
  live?: Money | null,
): Money | null {
  if (!baseline || !live) return null;
  if (baseline.amount === live.amount && baseline.currency === live.currency) return null;
  return live;
}
