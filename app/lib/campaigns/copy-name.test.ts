import { describe, expect, it } from "vitest";

import { copyName } from "./copy-name";

describe("copyName", () => {
  it("says where the copy came from", () => {
    expect(copyName("Summer sale", [])).toBe("Summer sale (copy)");
  });

  it("keeps four copies of one campaign distinguishable", () => {
    // The failure this prevents is not a collision -- names are not unique in the
    // database. It is a list of four rows with identical names, which is exactly the
    // thing the merchant duplicated the campaign to avoid.
    const taken = ["Summer sale", "Summer sale (copy)", "Summer sale (copy 2)"];

    expect(copyName("Summer sale", taken)).toBe("Summer sale (copy 3)");
  });

  it("numbers from two, because the first copy is the unnumbered one", () => {
    expect(copyName("Sale", ["Sale (copy)"])).toBe("Sale (copy 2)");
  });

  it("does not stack a suffix per generation", () => {
    // Duplicating a duplicate: "(copy) (copy)" grows a word per generation and says
    // less with each one.
    expect(copyName("Sale (copy)", ["Sale (copy)"])).toBe("Sale (copy 2)");
    expect(copyName("Sale (copy 2)", ["Sale (copy)", "Sale (copy 2)"])).toBe("Sale (copy 3)");
  });

  it("leaves a name that merely mentions copies alone", () => {
    // Only a trailing suffix is ours. "Copy deck pricing" is a campaign name.
    expect(copyName("Copy deck pricing", [])).toBe("Copy deck pricing (copy)");
  });
});

describe("copyName for a practice campaign's real copy (#1077)", () => {
  it("says which of the two is the real one", () => {
    // Side by side in the list, "Practice · 21/09/2026" and its copy have to be told apart
    // by the one that can be applied.
    expect(copyName("Practice · 21/09/2026", ["Practice · 21/09/2026"], "real")).toBe("Practice · 21/09/2026 (real)");
  });

  it("numbers a second one, and does not stack the suffix", () => {
    const taken = ["Sale", "Sale (real)"];
    expect(copyName("Sale", taken, "real")).toBe("Sale (real 2)");
    expect(copyName("Sale (real)", taken, "real")).toBe("Sale (real 2)");
  });

  it("keeps the other suffix, which is part of the source's name", () => {
    // A real copy of a practice campaign's duplicate is a real copy of that duplicate.
    expect(copyName("Sale (copy)", [], "real")).toBe("Sale (copy) (real)");
    expect(copyName("Sale (real)", [])).toBe("Sale (real) (copy)");
  });
});
