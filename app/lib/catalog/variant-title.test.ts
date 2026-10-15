import { describe, expect, it } from "vitest";

import { variantDisplayTitle } from "./variant-title";

describe("a variant's display title (#782)", () => {
  it("is the product's title alone for a product with no options", () => {
    expect(variantDisplayTitle("QA Recapture Board", "Default Title")).toBe("QA Recapture Board");
  });

  it("joins the product's and the variant's titles otherwise", () => {
    expect(variantDisplayTitle("Alpine Backpack 133", "S / Red")).toBe("Alpine Backpack 133 · S / Red");
  });

  it("is whichever exists, or nothing", () => {
    expect(variantDisplayTitle(null, "S")).toBe("S");
    expect(variantDisplayTitle("Board", null)).toBe("Board");
    expect(variantDisplayTitle(null, "Default Title")).toBeNull();
    expect(variantDisplayTitle("", "")).toBeNull();
  });
});
