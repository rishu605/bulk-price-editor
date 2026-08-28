import { humanise } from "../lib/format/label";
import type { MarketPreview, PreviewRow } from "../services/campaigns/index.server";
import { PREVIEW_TONE, toneFor } from "./tone";

/**
 * Before/after for each variant a campaign would change, one column per surface.
 *
 * The columns are the point when a campaign prices into markets. A merchant looking at
 * a euro sale and a yen sale in separate places cannot see that one of them rounded to
 * something strange; side by side, they can.
 */
export function PreviewTable({
  rows,
  markets = [],
}: {
  rows: PreviewRow[];
  markets?: MarketPreview[];
}) {
  if (rows.length === 0) {
    return (
      <s-paragraph>
        Nothing to change. Either every variant already shows the target price, or the
        scope matched no variants with baselines.
      </s-paragraph>
    );
  }

  return (
    <s-table>
      <s-table-header-row>
        <s-table-header listSlot="primary">Variant</s-table-header>
        <s-table-header listSlot="labeled" format="currency">Before</s-table-header>
        <s-table-header listSlot="labeled" format="currency">After</s-table-header>
        <s-table-header listSlot="labeled" format="currency">Compare at</s-table-header>
        {/* A market column holds a price, or "Not sold here" where there is none. Still
            a money column: a short phrase sitting exactly where the price would have
            been is the answer to "what does this market do", and left-aligning the whole
            column so that one phrase can start at the margin costs every other row the
            decimal alignment that makes a currency scannable. */}
        {markets.map((market) => (
          <s-table-header key={market.priceListGid} listSlot="labeled" format="currency">
            {market.name} ({market.currency})
          </s-table-header>
        ))}
        <s-table-header listSlot="inline">State</s-table-header>
      </s-table-header-row>
      <s-table-body>
        {rows.map((row) => (
          <s-table-row key={row.variantGid}>
            <s-table-cell>{row.title}</s-table-cell>
            <s-table-cell>{row.before ?? "\u2014"}</s-table-cell>
            <s-table-cell>{row.after ?? "\u2014"}</s-table-cell>
            <s-table-cell>{row.compareAt ?? "\u2014"}</s-table-cell>
            {markets.map((market) => (
              <s-table-cell key={market.priceListGid}>
                {describeCell(row, market.priceListGid)}
              </s-table-cell>
            ))}
            <s-table-cell>
              <s-badge tone={toneFor(PREVIEW_TONE, row.status)}>
                {humanise(row.status)}
                {row.reason ? ` \u00b7 ${row.reason}` : ""}
              </s-badge>
            </s-table-cell>
          </s-table-row>
        ))}
      </s-table-body>
    </s-table>
  );
}

/**
 * One variant's price on one market.
 *
 * "Not sold here" rather than a dash for a variant the market has no price for. A dash
 * reads as "no change", and the difference matters: one means the campaign leaves the
 * price alone, the other means there is no price there to leave alone.
 */
function describeCell(row: PreviewRow, priceListGid: string): string {
  const cell = row.surfaces?.[priceListGid];
  if (!cell) return "Not sold here";

  if (cell.status !== "pending") {
    return cell.reason ? `${humanise(cell.status)} \u00b7 ${cell.reason}` : humanise(cell.status);
  }

  const price = cell.after ?? "\u2014";
  return cell.compareAt ? `${price} was ${cell.compareAt}` : price;
}
