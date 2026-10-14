import { describe, expect, it } from "vitest";

import { importSegmentName } from "./segment-name";

describe("the segment a spreadsheet campaign is built on (#719)", () => {
  it("is named after the campaign", () => {
    expect(importSegmentName("Sale · 25/09/2026", [])).toBe("Sale · 25/09/2026 (imported)");
  });

  it("takes the next free number when the day's name is already used", () => {
    expect(importSegmentName("Sale", ["Sale (imported)"])).toBe("Sale (imported 2)");
    expect(importSegmentName("Sale", ["Sale (imported)", "Sale (imported 2)"])).toBe("Sale (imported 3)");
  });
});
