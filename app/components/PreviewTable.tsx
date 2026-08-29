import { humanise } from "../lib/format/label";
import { MoneyCell } from "./MoneyCell";
import { EmptyState } from "./AsyncState";
import { ShowingSome } from "./Pagination";
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
  total,
}: {
  rows: PreviewRow[];
  markets?: MarketPreview[];
  /**
   * Every row the campaign would change, not just the ones that fit.
   *
   * `rowsThatFit` caps this table to keep Polaris from blanking the page, and the cap
   * shrinks as markets add columns — so the same campaign shows fewer rows to the
   * merchant who has most reason to check them. Saying the number out loud is the
   * difference between a preview and a sample presented as a preview.
   */
  total?: number;
}) {
  if (rows.length === 0) {
    return (
      <EmptyState
        title="Nothing to change"
        description="Either every variant in scope already shows the price this rule computes, or the scope matched no variants that have a baseline to compute from."
      />
    );
  }

  return (
    <>
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
            <s-table-cell>
              <MoneyCell amount={row.before} />
            </s-table-cell>
            <s-table-cell>
              <MoneyCell amount={row.after} />
            </s-table-cell>
            <s-table-cell>
              <MoneyCell amount={row.compareAt} />
            </s-table-cell>
            {markets.map((market) => {
              const cell = describeCell(row, market.priceListGid);
              return (
                <s-table-cell key={market.priceListGid}>
                  {cell.kind === "price" ? (
                    <MoneyCell amount={cell.amount} compareAt={cell.compareAt} />
                  ) : (
                    // Not a number, so not a `MoneyCell`. "Not sold here" and a skip
                    // reason are phrases, and the column stays right-aligned under them
                    // for the reason the header comment gives: one phrase must not cost
                    // every price in the column its decimal alignment.
                    <s-text color="subdued">{cell.text}</s-text>
                  )}
                </s-table-cell>
              );
            })}
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
    {total === undefined ? null : (
      <ShowingSome
        shown={rows.length}
        total={total}
        noun="rows"
        suffix="Every row is priced the same way, and the export has all of them."
      />
    )}
    </>
  );
}

/**
 * One variant's price on one market: either a price, or a phrase saying why there isn't
 * one.
 *
 * Returns the two apart rather than as one string. It used to build
 * `` `${price} was ${cell.compareAt}` ``, which put a number and a word in the same text
 * run of a right-aligned column \u2014 so a market cell wrapped at "was" and no two prices in
 * the column started at the same place. `MoneyCell` carries the full account; the shape
 * of this function is the half of the fix that lives here, because a caller cannot
 * right-align a number it has already glued a word to.
 *
 * "Not sold here" rather than a dash for a variant the market has no price for. A dash
 * reads as "no change", and the difference matters: one means the campaign leaves the
 * price alone, the other means there is no price there to leave alone.
 */
type MarketCell =
  | { kind: "price"; amount: string | null; compareAt: string | null }
  | { kind: "text"; text: string };

function describeCell(row: PreviewRow, priceListGid: string): MarketCell {
  const cell = row.surfaces?.[priceListGid];
  if (!cell) return { kind: "text", text: "Not sold here" };

  if (cell.status !== "pending") {
    return {
      kind: "text",
      text: cell.reason
        ? `${humanise(cell.status)} \u00b7 ${cell.reason}`
        : humanise(cell.status),
    };
  }

  return { kind: "price", amount: cell.after ?? null, compareAt: cell.compareAt ?? null };
}
