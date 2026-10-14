/**
 * The markets a preview gives a column to: the ones the campaign will price.
 *
 * A refused market has no cells -- the preview skips it, and the Markets card says why --
 * so a column for it filled every row with "Not sold here", on products Shopify sells
 * there at their normal price (#770). The table and the CSV both take their columns from
 * here, so the file can't say what the screen doesn't.
 */
export function pricedMarkets<Market extends { refused: boolean }>(markets: readonly Market[]): Market[] {
  return markets.filter((market) => !market.refused);
}
