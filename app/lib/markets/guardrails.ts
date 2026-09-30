/**
 * The store's guardrails, as they apply to a market priced in its own currency (#691).
 *
 * Settings are entered once, in the store's currency, and a market is priced in its
 * own. Two consequences, and both used to be silent:
 *
 *   A minimum price is a figure in one currency. Comparing $5.00 with a euro price threw
 *   `CurrencyMismatchError`, the run caught it as "market prices did not finish", and
 *   every market after it went unpriced. There is no Shopify figure to convert it by
 *   that the app could stand behind, so it is not applied to a market in another
 *   currency; it still applies to one in the store's own.
 *
 *   A cost is recorded only in the store's currency. A market in that currency is checked
 *   against it like the base price; in any other, "never below cost" and a minimum
 *   margin cannot be checked, and those rows are skipped under the store's missing-cost
 *   policy -- the safe direction, but a skip nobody is told about leaves a market at full
 *   price for the whole sale. `describeMarketSkips` is the sentence the run and the
 *   preview now say instead.
 */

import type { Guardrails, ResolutionReason } from "../pricing/types";
import { SKIP_REASON_GROUP } from "../planning/reasons";

/** The store's guardrails for a market in `currency`. */
export function marketGuardrails(store: Guardrails, currency: string): Guardrails {
  if (!store.minPrice || store.minPrice.currency === currency) return store;
  const forMarket = { ...store };
  delete forMarket.minPrice;
  return forMarket;
}

/**
 * One sentence per reason a market's rows were left alone, naming the market.
 *
 * Missing cost in a foreign-currency market gets its own wording: the merchant may well
 * have recorded a cost, just not in this currency, and "have no cost recorded" would send
 * them to fix something that is fine. In the store's own currency it means what it says.
 */
export function describeMarketSkips(
  market: string,
  currency: string,
  rows: ReadonlyArray<{ status: string; reason?: ResolutionReason }>,
  inStoreCurrency = false,
): string[] {
  const byReason = new Map<string, number>();
  for (const row of rows) {
    if (row.status !== "skipped") continue;
    const reason = row.reason ?? "unknown";
    byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
  }

  return [...byReason]
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => {
      const variants = `${count} ${count === 1 ? "variant" : "variants"}`;
      if (reason === "missing-cost" && !inStoreCurrency) {
        return (
          `${market}: ${variants} left at full price. Costs are recorded in your store's ` +
          `currency only, so a cost-based guardrail (never below cost, minimum margin) ` +
          `cannot be checked in ${currency}.`
        );
      }
      const why = SKIP_REASON_GROUP[reason as ResolutionReason];
      return why
        ? `${market}: ${variants} left at full price: they ${why}.`
        : `${market}: ${variants} left at full price (${reason}).`;
    });
}
