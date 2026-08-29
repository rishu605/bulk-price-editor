/**
 * Every price file this shop has imported.
 *
 * A campaign can price *from* an import, so "which file is this campaign reading?" is a
 * question about campaigns — and `price_imports` had recorded every one since the feature
 * shipped with nothing displaying them until #351. It moved here when the import stopped
 * being a page of its own (#445) and became one of the ways prices change.
 *
 * Its own component rather than more markup in the editor: the editor is the longest file
 * in the app, and a table that only renders on one branch of one option is exactly the
 * kind of thing that makes a long file unreadable.
 *
 * Baselines and costs record no import row. A real gap rather than an omission here, and
 * still said out loud rather than papered over.
 */

import { EmptyState } from "../AsyncState";
import { Blank } from "../Blank";
import { formatCount } from "../../lib/format/display";

export interface PriceImportRow {
  id: string;
  name: string;
  currency: string;
  rowsRead: number;
  rowsMatched: number;
  createdBy: string | null;
  /** Already formatted, in the shop's zone — see `formatWhen`. */
  createdAt: string;
}

export function PriceImportHistory({
  imports,
  timeZone,
}: {
  imports: PriceImportRow[];
  timeZone: string;
}) {
  return (
    <s-section heading="Price files you have imported">
      {imports.length === 0 ? (
        <EmptyState
          title="Nothing imported yet"
          description="Every file you import is recorded here with its row counts and who ran it, so you can always answer which file a campaign is pricing from."
        />
      ) : (
        <>
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="kicker">Imported</s-table-header>
              <s-table-header listSlot="primary">File</s-table-header>
              <s-table-header listSlot="labeled" format="numeric">
                Rows read
              </s-table-header>
              <s-table-header listSlot="secondary" format="numeric">
                Matched a variant
              </s-table-header>
              <s-table-header listSlot="labeled">By</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {imports.map((row) => (
                <s-table-row key={row.id}>
                  <s-table-cell>{row.createdAt}</s-table-cell>
                  <s-table-cell>
                    {row.name} <s-text color="subdued">({row.currency})</s-text>
                  </s-table-cell>
                  <s-table-cell>{formatCount(row.rowsRead)}</s-table-cell>
                  <s-table-cell>
                    {/* The gap between these two is the number worth reading: rows that
                        named a variant this shop does not have. */}
                    {formatCount(row.rowsMatched)}
                    {row.rowsMatched < row.rowsRead ? (
                      <s-text tone="caution">
                        {" "}
                        · {formatCount(row.rowsRead - row.rowsMatched)} matched nothing
                      </s-text>
                    ) : null}
                  </s-table-cell>
                  <s-table-cell>{row.createdBy ?? <Blank />}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
          <s-paragraph>
            <s-text color="subdued">Times are your store&rsquo;s, in {timeZone}.</s-text>
          </s-paragraph>
        </>
      )}
    </s-section>
  );
}
