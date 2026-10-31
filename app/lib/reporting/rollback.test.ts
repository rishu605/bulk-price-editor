/**
 * Row classification and the export.
 *
 * The classification decides whether a revert asks a person a question. Getting it
 * wrong in one direction silently overwrites a deliberate edit; in the other it fills
 * the report with questions about rows nobody touched, which trains people to click
 * through it — and then the rows that mattered go with them.
 */

import { describe, expect, it } from "vitest";

import {
  classifyRollbackRow,
  marketsNotBeforeSentence,
  notBeforeSentence,
  rollbackReportCsv,
  rollbackSummary,
  unaffectedSentence,
  type RollbackReport,
} from "./rollback";

describe("classifyRollbackRow", () => {
  it("calls a row clean when live matches what we applied", () => {
    expect(classifyRollbackRow({ deleted: false, applied: 8_000, live: 8_000, revertsTo: 10_000 })).toBe("clean");
  });

  it("calls a row drifted when somebody changed it since", () => {
    expect(classifyRollbackRow({ deleted: false, applied: 8_000, live: 7_500, revertsTo: 10_000 })).toBe("drifted");
  });

  it("reports a deleted variant as deleted rather than drifted", () => {
    // A merchant removing a product mid-sale is ordinary. Surfacing it as a conflict
    // needing resolution would be asking a question with no answer (E4).
    expect(classifyRollbackRow({ deleted: true, applied: 8_000, live: null, revertsTo: null })).toBe("deleted");
  });

  it("prefers deleted over drifted when both look true", () => {
    expect(classifyRollbackRow({ deleted: true, applied: 8_000, live: 7_500, revertsTo: 10_000 })).toBe("deleted");
  });

  it("treats an unknown comparison as clean, not as a question", () => {
    // No mirrored live value, or nothing recorded as applied. There is no evidence of
    // an edit, and inventing one costs the merchant attention they will stop paying.
    expect(classifyRollbackRow({ deleted: false, applied: null, live: 8_000, revertsTo: 10_000 })).toBe("clean");
    expect(classifyRollbackRow({ deleted: false, applied: 8_000, live: null, revertsTo: 10_000 })).toBe("clean");
  });

  /**
   * The three cases of #836, from its live repro: a probe at 200.00, sale A (priority 100)
   * at 180.00, then sale B (priority 200) at 170.00 over the same variant. A's revert is
   * `resolve(without A)`, which is B's 170.00.
   */
  describe("against what the revert writes (#836)", () => {
    it("is clean while the live price is what this campaign applied", () => {
      expect(classifyRollbackRow({ deleted: false, applied: 18_000, live: 18_000, revertsTo: 20_000 })).toBe("clean");
    });

    it("is not drifted when a higher-priority campaign's price is what the revert leaves there", () => {
      const kind = classifyRollbackRow({ deleted: false, applied: 18_000, live: 17_000, revertsTo: 17_000 });
      expect(kind, "B's price read as somebody's edit").not.toBe("drifted");
      expect(kind).toBe("unaffected");
    });

    it("is not drifted when the live price is already the baseline the revert writes", () => {
      expect(classifyRollbackRow({ deleted: false, applied: 18_000, live: 20_000, revertsTo: 20_000 })).toBe("unaffected");
    });

    it("is still drifted when the live price is neither what was applied nor what the revert writes", () => {
      // A real hand edit under B: 175.00 is not A's 180.00, and not B's 170.00.
      expect(classifyRollbackRow({ deleted: false, applied: 18_000, live: 17_500, revertsTo: 17_000 })).toBe("drifted");
    });

    it("is still drifted when the revert gives no price to compare with", () => {
      // The revert's planner skips the variant; there is no answer it could already be at.
      expect(classifyRollbackRow({ deleted: false, applied: 18_000, live: 17_500, revertsTo: null })).toBe("drifted");
    });
  });
});

describe("what the Revert tab says about the rows (#836)", () => {
  const counts = (over: Partial<RollbackReport["counts"]>): RollbackReport["counts"] => ({
    total: 0,
    clean: 0,
    drifted: 0,
    deleted: 0,
    unaffected: 0,
    ...over,
  });

  it("says every row is at the campaign's price only when every row is", () => {
    expect(rollbackSummary(counts({ total: 3, clean: 3 }))).toContain("All 3 variants are still at the price this campaign set");
    expect(rollbackSummary(counts({ total: 1, clean: 1 }))).toContain("The 1 variant is still at the price");
  });

  it("does not say a variant another campaign took over is at this campaign's price", () => {
    const said = rollbackSummary(counts({ total: 3, clean: 2, unaffected: 1 }));
    expect(said).not.toContain("All 3");
    expect(said).toContain("2 of 3 variants are still at the price this campaign set");
    expect(rollbackSummary(counts({ total: 1, unaffected: 1 }))).not.toContain("still at the price");
  });

  it("asks about the drifted rows, and only those", () => {
    expect(rollbackSummary(counts({ total: 3, clean: 1, drifted: 1, unaffected: 1 }))).toContain("1 of 3 variants has been changed");
    expect(rollbackSummary(counts({ total: 3, clean: 1, drifted: 2 }))).toContain("2 of 3 variants have been changed");
  });

  it("groups its counts, and agrees with one (#759)", () => {
    expect(rollbackSummary(counts({ total: 3669, clean: 3669 }))).toContain("All 3,669 variants");
    expect(rollbackSummary(counts({ total: 3669, clean: 1200 }))).toContain("1,200 of 3,669 variants are still");
    expect(rollbackSummary(counts({ total: 3669, clean: 1 }))).toContain("1 of 3,669 variants is still");
    expect(rollbackSummary(counts({ total: 3669, drifted: 1200 }))).toContain("1,200 of 3,669 variants have been changed");
  });

  it("leaves how reverting works to the paragraph under it, rather than saying it twice (#759)", () => {
    // The tab's next paragraph is "Reverting recomputes each price without this campaign",
    // so a summary ending "Reverting recomputes each one without it" read the same thing
    // twice in a row.
    for (const over of [{ total: 3, clean: 3 }, { total: 1, clean: 1 }, { total: 3, clean: 2 }, { total: 3, clean: 1 }]) {
      expect(rollbackSummary(counts(over))).not.toMatch(/recomputes/i);
    }
  });

  it("explains the rows reverting leaves where they are, and says nothing when there are none", () => {
    expect(unaffectedSentence(0)).toBeNull();
    expect(unaffectedSentence(1)).toContain("1 variant already shows the price reverting gives it");
    expect(unaffectedSentence(4)).toContain("4 variants already show");
  });
});

describe("the variants reverting does not put back at their price from before (#781)", () => {
  const board = { title: "QA Recapture Board", before: "100.00", revertsTo: "80.00" };

  it("says nothing when there are none", () => {
    expect(notBeforeSentence(undefined)).toBeNull();
    expect(notBeforeSentence({ count: 0, recaptured: 0, examples: [] })).toBeNull();
  });

  it("names the live case: the price from before, the recapture, and what to do", () => {
    expect(notBeforeSentence({ count: 1, recaptured: 1, examples: [board] })).toBe(
      "1 variant reverts to a different price from the one the ledger recorded before this campaign: " +
        "“QA Recapture Board” reverts to 80.00, not 100.00. Its baseline was recaptured at this campaign's sale price, " +
        "so reverting leaves the sale price in place. To end the sale at the price from before it, import that price " +
        "as the baseline on Prices → Baselines, then revert.",
    );
  });

  it("names a few, counts the rest, and claims a recapture only of the ones that had one", () => {
    const sentence = notBeforeSentence({ count: 1_204, recaptured: 4, examples: [board, board, board] })!;
    expect(sentence).toMatch(/^1,204 variants revert to a different price/);
    expect(sentence).toContain("; and 1,201 more, in the export.");
    expect(sentence).toContain(" 4 of them had their baseline recaptured at this campaign's sale price");
    expect(notBeforeSentence({ count: 2, recaptured: 0, examples: [board, board] })).not.toContain("recaptured");
  });
});

describe("the market prices reverting leaves at this campaign's sale price (#1166)", () => {
  const board = { title: "QA Recapture Board", market: "Europe", before: "€50.00", revertsTo: "€40.00" };

  it("says nothing when there are none", () => {
    expect(marketsNotBeforeSentence(undefined)).toBeNull();
    expect(marketsNotBeforeSentence({ count: 0, examples: [] })).toBeNull();
  });

  it("names the market and the price before, and says what to do, which is not an import", () => {
    expect(marketsNotBeforeSentence({ count: 1, examples: [board] })).toBe(
      "1 market price reverts to this campaign's sale price, not the price before it: “QA Recapture Board” in Europe " +
        "reverts to €40.00, not €50.00. Its baseline was recaptured at the sale price, and reverting writes a market's " +
        "baseline back. An import cannot set a market's price, so to end the sale at the price from before it, revert, " +
        "then set that price in Shopify and recapture its baseline on Prices → Baselines.",
    );
  });

  it("names a few and counts the rest", () => {
    const sentence = marketsNotBeforeSentence({ count: 40, examples: [board, board, board] })!;
    expect(sentence).toMatch(/^40 market prices revert to this campaign's sale price/);
    expect(sentence).toContain("; and 37 more.");
    expect(sentence).toContain("Their baselines were recaptured");
    expect(sentence).toContain("set those prices in Shopify and recapture their baselines");
  });
});

describe("rollbackReportCsv", () => {
  const report = (rows: RollbackReport["rows"]): RollbackReport => ({
    campaignId: "c1",
    campaignName: "Summer sale",
    rows,
    counts: { total: rows.length, clean: 0, drifted: 0, deleted: 0, unaffected: 0 },
    straightforward: false,
  });

  it("writes a header and one row per variant", () => {
    const csv = rollbackReportCsv(
      report([
        {
          variantGid: "gid://Variant/1",
          title: "Blue shirt",
          kind: "drifted",
          applied: "$80.00",
          live: "$75.00",
          revertsTo: "$100.00",
        },
      ]),
    );

    const lines = csv.trim().split("\n");
    // Header quoted like every other cell. Uniform quoting means there is no cell
    // whose safety depends on someone having checked it could not contain a comma.
    expect(lines[0]).toBe(
      '"variant_gid","title","state","applied","live_now","reverts_to","before_campaign"',
    );
    expect(lines[1]).toBe(
      '"gid://Variant/1","Blue shirt","drifted","$80.00","$75.00","$100.00",""',
    );
  });

  it("gives the price from before the campaign where reverting does not put it back (#781)", () => {
    const csv = rollbackReportCsv(
      report([
        {
          variantGid: "gid://Variant/4",
          title: "QA Recapture Board",
          kind: "clean",
          applied: "$80.00",
          live: "$80.00",
          revertsTo: "$80.00",
          before: "$100.00",
        },
      ]),
    );

    expect(csv.trim().split("\n")[1]).toBe('"gid://Variant/4","QA Recapture Board","clean","$80.00","$80.00","$80.00","$100.00"');
  });

  it("survives titles containing commas and quotes", () => {
    // Product titles carry both routinely — a 24" monitor, "Red, large". A report that
    // corrupts itself on ordinary catalogue data is not a record of anything.
    const csv = rollbackReportCsv(
      report([
        {
          variantGid: "gid://Variant/2",
          title: 'Monitor, 24" — "Pro"',
          kind: "clean",
          applied: "$80.00",
          live: "$80.00",
          revertsTo: "$100.00",
        },
      ]),
    );

    expect(csv).toContain('"Monitor, 24"" — ""Pro"""');
    expect(csv.trim().split("\n")).toHaveLength(2);
  });

  it("writes empty cells rather than the word null", () => {
    const csv = rollbackReportCsv(
      report([
        {
          variantGid: "gid://Variant/3",
          title: "Gone",
          kind: "deleted",
          applied: "$80.00",
          live: null,
          revertsTo: null,
        },
      ]),
    );

    expect(csv).toContain('"gid://Variant/3","Gone","deleted","$80.00","",""');
    expect(csv).not.toContain("null");
  });
});
