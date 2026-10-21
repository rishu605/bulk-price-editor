/**
 * What Home says when the store's currency has no precision Anchor knows (#1089).
 *
 * Every code in the pinned Admin schema is registered except XXX, which the schema uses for a
 * currency Shopify does not recognise; a code a later schema adds is the other way here. The
 * sync stops before reading a product, because every price would otherwise throw, and the
 * store cannot fix that by syncing again. So the sentence names the currency, says support
 * has been sent it, and says what, if anything, is the merchant's to do -- under a heading
 * that says so, not one reporting a sync that failed.
 *
 * Here rather than in the sync job so Home's component can read the heading: the job is a
 * server module, and the banner renders in the browser too.
 */

import { SUPPORT_ADDRESS } from "../support/contact";

const OPENING = "Anchor can't price in your store's currency";

/** The heading of the banner for a currency Anchor cannot price. */
export const UNPRICED_CURRENCY_HEADING = OPENING;

/** The heading of the banner for any other sync that stopped or finished with problems. */
export const SYNC_STOPPED_HEADING = "The last sync did not finish cleanly";

/** The sentence the sync records, and Home shows, for a store in `currency`. */
export function unpricedCurrencyFailure(currency: string): string {
  const read = "Anchor read none of your products rather than guess, and nothing in your store was changed.";
  if (currency === "XXX") {
    return (
      `${OPENING}: Shopify reports it as XXX, its code for a currency it does not recognise, so there is no ` +
      `telling how many decimal places your prices have. ${read} Support has been sent this. Check the store ` +
      "currency in your Shopify settings, then sync again from here."
    );
  }
  return (
    `${OPENING}, ${currency}, yet: it does not know how many decimal places ${currency} prices have. ${read} ` +
    `Support has been sent this so ${currency} can be added; write to ${SUPPORT_ADDRESS} to hear when, then ` +
    "sync again from here."
  );
}

/** Which heading Home puts over the sync's failure sentence. */
export function syncFailureHeading(failure: string): string {
  return failure.startsWith(OPENING) ? UNPRICED_CURRENCY_HEADING : SYNC_STOPPED_HEADING;
}
