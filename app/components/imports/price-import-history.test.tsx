/**
 * The history names the gap between rows read and rows imported for what it is (#989).
 *
 * It said "matched nothing" for every row not imported, refused currencies and bad prices
 * included; the record keeps only the two counts, not each row's reason.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PriceImportHistory } from "./PriceImportHistory";

describe("the price import history", () => {
  it("says how many rows were not imported, not that they matched nothing", () => {
    const html = renderToStaticMarkup(
      <PriceImportHistory
        timeZone="UTC"
        imports={[
          {
            id: "imp_1",
            name: "Sale · 25 Sep 2026",
            createdAt: "2026-09-25T10:00:00.000Z",
            rowsRead: 7,
            rowsMatched: 3,
            createdBy: "staff:91614707946",
            campaignId: null,
          } as never,
        ]}
      />,
    );
    expect(html).toContain("4 not imported");
    expect(html).not.toContain("matched nothing");
    expect(html).toContain("Staff 7946");
  });
});
