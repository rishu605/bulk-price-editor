/**
 * The badge counts what the table would show, and is not capped by the filter's bound.
 *
 * `counts()` used to be `driftedCells(shopId).length`, and `driftedCells` ends in
 * `LIMIT 5000` — so a store with 8,000 drifted prices was told it had **5,000**. Not an
 * error, not a "5,000+", just a specific plausible number that happened to be the cap.
 * `reconcile`'s own doc comment explains why that is the worst available failure:
 *
 *   "12 products have drifted" is the number a merchant needs; "0 on this page" tells
 *   them nothing and quietly implies everything is fine.
 *
 * A capped count fails that test in a way "0 on this page" does not, because 5,000 does
 * not read as a ceiling.
 *
 * The cap itself is right where it is. The cells list feeds a `WHERE … IN`, and bounding
 * how many variants that names is deliberate. It was only ever wrong as an answer to
 * "how many".
 *
 * These assert on the composed SQL rather than on results, because the property is about
 * how the two questions are built: they must share one definition of what "drifted"
 * means, and only one of them may carry the bound. Whether the numbers are then right is
 * `reconciliation.chaos.ts`'s job, against a real engine and a real ledger.
 */

import { describe, expect, it } from "vitest";

import {
  cellsQuery,
  countQuery,
  driftedFrom,
  MAX_FILTER_CELLS,
  offBaselineFrom,
} from "./reconciliation.server";

/** The statement as Postgres receives it, parameter placeholders and all. */
const text = (sql: { sql: string }): string => sql.sql.replace(/\s+/g, " ").trim();

describe("counting is not listing", () => {
  it("counts without the filter's row bound", () => {
    const sql = text(countQuery(driftedFrom("shop_1")));

    expect(sql).toContain("COUNT(*)");
    expect(sql).not.toContain("LIMIT");
  });

  it("lists with it", () => {
    expect(text(cellsQuery(driftedFrom("shop_1")))).toContain("LIMIT");
  });

  it("binds the bound rather than interpolating it", () => {
    // A cap spliced into the string would make every page a distinct statement and lose
    // the prepared-statement cache. It is also how a value reaches SQL unescaped.
    expect(cellsQuery(driftedFrom("shop_1")).values).toContain(MAX_FILTER_CELLS);
  });
});

describe("one definition of what has drifted", () => {
  it("asks the count and the list the same question", () => {
    // The two queries differ only in their projection and the bound. If they could drift
    // apart, the page would say "3 drifted" above a table showing four — which is the
    // failure this page exists to prevent, arriving through the page itself.
    const predicate = text(driftedFrom("shop_1"));

    expect(text(countQuery(driftedFrom("shop_1")))).toContain(predicate);
    expect(text(cellsQuery(driftedFrom("shop_1")))).toContain(predicate);
  });

  it("does the same for off-baseline", () => {
    const predicate = text(offBaselineFrom("shop_1"));

    expect(text(countQuery(offBaselineFrom("shop_1")))).toContain(predicate);
    expect(text(cellsQuery(offBaselineFrom("shop_1")))).toContain(predicate);
  });
});

describe("the shop is a parameter", () => {
  it.each([
    ["drifted", driftedFrom],
    ["off-baseline", offBaselineFrom],
  ])("binds the shop id in the %s predicate", (_name, build) => {
    const sql = build("shop_1");

    expect(sql.values).toContain("shop_1");
    expect(text(sql)).not.toContain("shop_1");
  });
});

describe("the drift predicate still describes drift", () => {
  const sql = text(driftedFrom("shop_1"));

  it("reads the newest verified write per cell", () => {
    // `DISTINCT ON` with this ordering is what `variant_changes_drift_lookup` was built
    // to serve. Reordering the sort keys silently returns Postgres to sorting the whole
    // ledger — a 14x regression that no result-level assertion would notice.
    expect(sql).toContain('DISTINCT ON (c."variantGid", c."priceListGid")');
    expect(sql).toContain('ORDER BY c."variantGid", c."priceListGid", c."verifiedAt" DESC');
  });

  it("considers only cells a campaign has written", () => {
    // An inner join, not a left join: a cell nothing ever promised a price for cannot
    // have drifted from that promise.
    expect(sql).toContain("JOIN (");
    expect(sql).not.toContain("LEFT JOIN");
  });

  it("compares live against intended", () => {
    expect(sql).toContain('e."livePrice" <> w."intendedPrice"');
  });
});
