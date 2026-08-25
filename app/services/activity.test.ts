/**
 * Turning a stored before/after into a line somebody can read.
 *
 * The audit log answers two questions: "what did this app do to my prices?" and "who
 * turned that off?". A summary reading "settings updated" answers neither, so the
 * field-level difference is the point rather than a nicety.
 */

import { describe, expect, it } from "vitest";

import { summarise } from "./activity.server";

describe("summarise", () => {
  it("names the fields that changed and both values", () => {
    expect(
      summarise("settings.guardrails.update", { minPrice: null }, { minPrice: 5 }),
    ).toBe("minPrice: — → 5");
  });

  it("reports several changes in one line", () => {
    const line = summarise(
      "settings.guardrails.update",
      { neverBelowCost: false, violationPolicy: "clamp" },
      { neverBelowCost: true, violationPolicy: "block" },
    );
    expect(line).toContain("neverBelowCost: false → true");
    expect(line).toContain("violationPolicy: clamp → block");
  });

  it("says so when an update changed nothing", () => {
    // Distinct from "no record". A merchant who saved a form and sees the entry needs
    // to know the save landed and simply moved nothing.
    expect(summarise("settings.guardrails.update", { minPrice: 5 }, { minPrice: 5 })).toBe(
      "no fields changed",
    );
  });

  it("describes a creation, which has an after and no before", () => {
    expect(summarise("campaign.variant.excluded", null, { variantGid: "gid://v/1" })).toBe(
      "variantGid: gid://v/1",
    );
  });

  it("falls back to the action name when there is nothing stored", () => {
    // Entries recorded before summaries existed must still read as something.
    expect(summarise("campaign.transition", null, null)).toBe("campaign.transition");
  });

  it("summarises arrays by count rather than dumping them", () => {
    // A frozen segment's variant list is thousands of gids. Rendering it would make
    // the row unreadable and the page enormous.
    expect(summarise("segment.update", null, { variantGids: ["a", "b", "c"] })).toBe(
      "variantGids: 3 item(s)",
    );
    expect(summarise("segment.update", null, { variantGids: [] })).toBe("variantGids: none");
  });

  it("truncates a long string rather than letting one row swallow the table", () => {
    const long = "x".repeat(200);
    const line = summarise("campaign.transition", null, { reason: long });
    expect(line.length).toBeLessThan(80);
    expect(line).toContain("…");
  });
});
