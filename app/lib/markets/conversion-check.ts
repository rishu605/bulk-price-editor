/**
 * Catching a market price Shopify never converted.
 *
 * A relative price list is meant to answer with the base price converted into the
 * market's currency and *then* adjusted by the list's percentage. On the dev store it
 * answers with the base price adjusted and not converted at all — an EUR list and a JPY
 * list returning byte-identical amounts, which is the tell. The cause is still open
 * (#257); this is the guard, which is right whatever the cause turns out to be.
 *
 * **The yen case fails loudly and the euro case does not, which is why this exists.**
 * ¥797.36 is absurd on sight and `parseMoney` refuses it for having decimals a
 * zero-decimal currency cannot have. €797.36 is a perfectly ordinary-looking price that
 * happens to be wrong by an exchange rate, and nothing downstream would ever question it.
 * A plausible wrong price written to a live storefront is the failure this product exists
 * to prevent.
 *
 * Deliberately operating on the decimal string Shopify sent, before it is parsed into
 * minor units. Parsing is where the yen case explodes, and it explodes with a message
 * about decimal places — which sends a merchant to look at their prices when the problem
 * is their market.
 */

import { exponentOf } from "../money/currency";

export interface ConversionCheck {
  /** The price list's currency, as declared on the list. */
  listCurrency: string;
  /** The shop's own currency — what the base price is denominated in. */
  shopCurrency: string;
  /** The base-surface price, in the shop currency's minor units. */
  baseMinorUnits: number;
  /** The list's parent adjustment. Zero is fine; null means the list is not relative. */
  adjustmentBps: number;
  /** Exactly what Shopify returned, before parsing. */
  derivedAmount: string;
}

/**
 * True when the derived amount is the base price with the rule applied and nothing else.
 *
 * The comparison is in major units, because the two currencies need not share a
 * minor-unit exponent and the whole point is that no conversion happened — there is no
 * sensible minor-unit space to compare in.
 *
 * Tolerance is one minor unit of the list's currency, since Shopify rounds its own way
 * and being out by a cent is still unmistakably "unconverted".
 *
 * A false positive requires a real exchange rate of exactly 1.0000 between two different
 * currencies. That is vanishingly rare, transient when it happens, and costs a refusal
 * rather than a wrong price — which is the trade worth making.
 */
export function looksUnconverted(check: ConversionCheck): boolean {
  const { listCurrency, shopCurrency, baseMinorUnits, adjustmentBps, derivedAmount } = check;

  // Same currency means there is nothing to convert and nothing to detect.
  if (listCurrency === shopCurrency) return false;

  const derived = Number(derivedAmount);
  if (!Number.isFinite(derived)) return false;

  const baseMajor = baseMinorUnits / 10 ** exponentOf(shopCurrency);
  const ruleOnly = (baseMajor * (10_000 + adjustmentBps)) / 10_000;

  const tolerance = 1 / 10 ** exponentOf(listCurrency);

  return Math.abs(derived - ruleOnly) <= tolerance;
}

/**
 * What a merchant is told when a market's prices come back unconverted.
 *
 * Names the market, says what is wrong in terms of the thing they configured, and gives
 * them somewhere to go — the error taxonomy in RFC §11. Deliberately does not guess at
 * the cause, because we do not know it yet, and a confident wrong diagnosis wastes more
 * of somebody's afternoon than an honest description does.
 */
export function unconvertedMessage(
  marketName: string,
  listCurrency: string,
  statedCurrency?: string,
): string {
  const inWhat = statedCurrency ? ` — it answered in ${statedCurrency}` : "";
  return (
    `${marketName} returned prices that are not in ${listCurrency}${inWhat}, so they are ` +
    `wrong by an exchange rate and this campaign will not price that market. ` +
    `Check the market's currency settings in Shopify under Settings → Markets → ` +
    `${marketName}, then run this again. Every other surface has been priced.`
  );
}
