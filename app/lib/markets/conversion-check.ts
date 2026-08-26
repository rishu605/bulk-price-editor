/**
 * What a merchant is told when a market answers in the wrong currency.
 *
 * There used to be a detector here too, inferring the problem from arithmetic: if the
 * amount equalled the base price with only the list's rule applied, no conversion had
 * happened. It was built on a wrong theory — that the market was misconfigured — and it
 * happened to catch the real case anyway.
 *
 * The real case turned out to be that `priceList.prices(originType: RELATIVE)` answers in
 * the *shop's* currency by design, and market prices now come from `contextualPricing`
 * instead (#264). So the check is a fact rather than an inference: refuse when the stated
 * currency is not the list's. The inference is gone; only the sentence a merchant reads
 * remains, because that part was always the useful half.
 */

/**
 * Names the market, says what is wrong in terms of the thing they configured, and gives
 * them somewhere to go — the error taxonomy in RFC §11.
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
