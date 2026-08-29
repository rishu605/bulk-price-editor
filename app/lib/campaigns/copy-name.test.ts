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
