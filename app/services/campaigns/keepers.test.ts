/**
 * What a revert leaves behind, named.
 *
 * `docs/help/concepts/revert.md` makes the argument with a jacket: £100 normally, £80 in
 * the summer sale, £70 once clearance starts. End the summer sale and restoring "what it
 * was before" gives £100 — while the right answer is £70, because clearance is still
 * running. Every competitor restores.
 *
 * This turns that paragraph into the merchant's own campaign names. The rows come from a
 * plan made with the campaign excluded, so a row's owner *is* whoever keeps the variant;
 * working it out from priorities here would be a second implementation of the resolver,
 * free to disagree with the one that will run.
 */

import { describe, expect, it } from "vitest";

import { keepersAfterRevert } from "./keepers.server";

const preview = (owners: Array<string | undefined>, planned = owners.length) => ({
  counts: { planned, noop: 0, skipped: 0, clamped: 0 },
  rows: owners.map((campaignId, index) => ({
    variantGid: `gid://v/${index}`,
    title: `Variant ${index}`,
    before: null,
    after: null,
    compareAt: null,
    status: "pending" as const,
    campaignId,
  })),
});

const NAMES = new Map([
  ["c_clear", "Clearance"],
  ["c_loyal", "Loyalty pricing"],
]);

describe("who keeps the variants", () => {
  it("names the campaign that still covers them", () => {
    const { keepers } = keepersAfterRevert(preview(["c_clear", "c_clear"]), "c_summer", NAMES);

    expect(keepers).toEqual([{ campaignId: "c_clear", name: "Clearance", variants: 2 }]);
  });

  it("does not count the campaign being reverted", () => {
    // Its own rows are the ones being given up, not kept.
    const { keepers } = keepersAfterRevert(preview(["c_summer", "c_clear"]), "c_summer", NAMES);

    expect(keepers).toEqual([{ campaignId: "c_clear", name: "Clearance", variants: 1 }]);
  });

  it("reports a keeper whose name we could not find, rather than dropping it", () => {
    // A dropped keeper is a count that is quietly wrong, and the count is the part a
    // merchant is deciding on.
    const { keepers } = keepersAfterRevert(preview(["c_ghost"]), "c_summer", NAMES);

    expect(keepers).toEqual([
      { campaignId: "c_ghost", name: "Another campaign", variants: 1 },
    ]);
  });

  it("puts the biggest keeper first", () => {
    const { keepers } = keepersAfterRevert(
      preview(["c_loyal", "c_clear", "c_clear", "c_clear"]),
      "c_summer",
      NAMES,
    );

    expect(keepers.map((keeper) => keeper.campaignId)).toEqual(["c_clear", "c_loyal"]);
  });

  it("finds none when nothing else covers the scope", () => {
    // The ordinary case: reverting puts every variant back to its baseline.
    expect(keepersAfterRevert(preview([undefined, "c_summer"]), "c_summer", NAMES).keepers).toEqual(
      [],
    );
  });
});

describe("how many prices move", () => {
  it("reports the planned count, because a revert is a write like any other", () => {
    expect(keepersAfterRevert(preview(["c_clear"], 812), "c_summer", NAMES).repriced).toBe(812);
  });
});
