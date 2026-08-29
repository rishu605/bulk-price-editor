/**
 * One field, and the four ways it can be wrong.
 *
 * The field is labelled "% off" and takes a positive number, which is the opposite sign
 * convention from the editor's own rule field. That is deliberate — asking for "-20" in a
 * box labelled "% off" is a double negative — and it is exactly the kind of deliberate
 * inconsistency that gets "tidied up" later, so the reasoning is pinned here.
 *
 * The refusals matter more than the acceptances. This control creates a campaign over the
 * *whole catalogue*, so a misread number is every price in the shop.
 */

import { describe, expect, it } from "vitest";

import { quickCampaignName, readQuickPercent } from "./quick-campaign";

describe("what it accepts", () => {
  it("reads a plain number as a discount", () => {
    expect(readQuickPercent("20")).toEqual({ ok: true, percent: 20 });
  });

  it("forgives a typed percent sign and stray spaces", () => {
    expect(readQuickPercent("  15 % ")).toEqual({ ok: true, percent: 15 });
  });

  it("keeps a fractional percentage rather than rounding it", () => {
    // 12.5% off is a real sale. Rounding here would silently price a different campaign
    // from the one the merchant asked for.
    expect(readQuickPercent("12.5")).toEqual({ ok: true, percent: 12.5 });
  });
});

describe("what it refuses, and why", () => {
  it("refuses nothing at all", () => {
    expect(readQuickPercent("   ")).toMatchObject({ ok: false });
  });

  it("refuses text, quoting what was typed", () => {
    const result = readQuickPercent("half");

    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.message).toContain("half");
  });

  it("refuses zero and negatives, and says where increases live", () => {
    // A negative here would mean a *rise* under the editor's convention, which is the
    // opposite of what the label says. Refusing is better than guessing which one was
    // meant across the whole catalogue.
    for (const raw of ["0", "-20"]) {
      const result = readQuickPercent(raw);
      expect(result, raw).toMatchObject({ ok: false });
      expect(result.ok === false && result.message).toContain("full editor");
    }
  });

  it("refuses 100 and above rather than making everything free", () => {
    for (const raw of ["100", "150"]) {
      expect(readQuickPercent(raw), raw).toMatchObject({ ok: false });
    }
  });
});

describe("the name it gives the campaign", () => {
  it("says what it is and when it was made", () => {
    expect(quickCampaignName(20, "29/08/2026")).toBe("20% off · 29/08/2026");
  });
});
