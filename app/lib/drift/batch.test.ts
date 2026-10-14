import { describe, expect, it } from "vitest";

import {
  batchParamFrom,
  describeBatch,
  describeDriftFilters,
  describeProgress,
  driftFiltersFrom,
  formatBatchParam,
  type BatchSummary,
} from "./batch";

describe("the queue's filters, from its URL", () => {
  it("reads the campaign, the product search and the direction", () => {
    expect(driftFiltersFrom(new URLSearchParams("campaign=c1&q=%20wool%20&direction=down"))).toEqual({
      campaignId: "c1",
      q: "wool",
      direction: "down",
    });
  });

  it("drops an empty or unknown value rather than filtering on it", () => {
    // An unknown direction filtering nothing is the safe reading: a bulk decision covers
    // what the page counted, and the page counted without it.
    expect(driftFiltersFrom(new URLSearchParams("campaign=&q=%20&direction=sideways"))).toEqual({
      campaignId: undefined,
      q: undefined,
      direction: undefined,
    });
  });

  it("names the product and direction in words, or nothing", () => {
    expect(describeDriftFilters({})).toBeNull();
    expect(describeDriftFilters({ q: "scarf", direction: "up" })).toBe(
      `title, SKU or ID contains "scarf", raised above the campaign's price`,
    );
  });
});

describe("a decision the page follows", () => {
  const ref = { resolution: "adopt" as const, campaignId: "cmabc123", asOf: "2026-10-15T08:30:00.123Z", total: 1113 };

  it("round-trips through the URL", () => {
    expect(batchParamFrom(formatBatchParam(ref))).toEqual(ref);
  });

  it("refuses anything it did not write", () => {
    for (const value of [null, "", "adopt.1.2", "drop.1760000000000.5.c1", "adopt.x.5.c1", "adopt.1760000000000.-1.c1", "adopt.1.2.c.d"]) {
      expect(batchParamFrom(value), String(value)).toBeNull();
    }
  });

  it("says how far it has got, and for a put-back how much is written", () => {
    expect(describeProgress(ref, "QA · perf", { done: 400, written: null, started: true })).toContain(
      'Keeping 1,113 changes for "QA · perf" in the background. 400 done, 713 to go.',
    );
    const putBack = { ...ref, resolution: "reassert" as const };
    expect(describeProgress(putBack, "Sale", { done: 0, written: null, started: false })).toContain(
      "Waiting for the background worker to start the run.",
    );
    expect(describeProgress(putBack, "Sale", { done: 0, written: 250, started: true })).toContain(
      "250 of 1,113 written and read back so far, in one run.",
    );
  });
});

describe("what a decision did, in sentences", () => {
  const base: BatchSummary = { resolution: "adopt", campaign: "Sale", resolved: 0, stillWaiting: 0, released: false };

  it("says what was kept, what was not and why, and what to do about it", () => {
    const text = describeBatch({ ...base, resolved: 40, notKept: 3, stillWaiting: 3 });
    expect(text).toContain('Kept 40 changes as the new baseline for "Sale".');
    expect(text).toContain("3 prices weren't kept: the storefront no longer shows the edit");
    expect(text).toContain("Choose Put it back or Leave it for now for those.");
    expect(text).toContain('3 prices still wait for a decision on "Sale".');
  });

  it("separates prices written from prices already right, and names the unconfirmed", () => {
    const text = describeBatch({ ...base, resolution: "reassert", resolved: 10, unchanged: 2, notConfirmed: 1, stillWaiting: 1 });
    expect(text).toContain('Put back 8 prices for "Sale", in one run: written and read back.');
    expect(text).toContain("2 prices already showed the campaign's price");
    expect(text).toContain("Shopify did not confirm 1 price, so it is still waiting.");
  });

  it("says the campaign runs again when nothing is left", () => {
    expect(describeBatch({ ...base, resolution: "ignore", resolved: 1, released: true })).toBe(
      'Left 1 price for "Sale" as they are, and closed their alerts. Nothing else was waiting, so "Sale" is running again.',
    );
  });

  it("never says nothing, even when there was nothing left to decide", () => {
    expect(describeBatch({ ...base, resolution: "ignore" })).toBe(
      'None of these prices for "Sale" were waiting any more: they were resolved after the page loaded. Nothing was changed.',
    );
  });

  it("puts a refusal in front of everything else when nothing was done", () => {
    expect(describeBatch({ ...base, resolution: "reassert", stopped: "The campaign is completed.", stillWaiting: 5 })).toBe(
      'The campaign is completed. 5 prices still wait for a decision on "Sale".',
    );
  });
});
