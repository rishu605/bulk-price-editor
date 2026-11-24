import { describe, expect, it } from "vitest";

import { addPicked, variantsPicked } from "./picker";
import { MAX_PICKED } from "./scope-builder";

const gid = (n: number) => `gid://shopify/ProductVariant/${n}`;

describe("the product picker's answer, as variants (#817)", () => {
  it("names each variant as the app does, dropping Shopify's Default Title", () => {
    expect(
      variantsPicked([
        { title: "Boot", variants: [{ id: gid(1), title: "Size 9" }, { id: gid(2), title: "Size 10" }] },
        { title: "Scarf", variants: [{ id: gid(3), title: "Default Title" }] },
      ]),
    ).toEqual([
      { gid: gid(1), title: "Boot · Size 9" },
      { gid: gid(2), title: "Boot · Size 10" },
      { gid: gid(3), title: "Scarf" },
    ]);
  });

  it("lists a variant once however it was picked", () => {
    expect(variantsPicked([{ title: "A", variants: [{ id: gid(1) }, { id: gid(1) }] }])).toHaveLength(1);
  });

  it("adds to a list without doubling, and says how many did not fit", () => {
    const full = Array.from({ length: MAX_PICKED - 1 }, (_, i) => gid(i));
    const { list, leftOver } = addPicked(full, [
      { gid: gid(0), title: "already there" },
      { gid: gid(1000), title: "fits" },
      { gid: gid(1001), title: "does not" },
    ]);
    expect(list).toHaveLength(MAX_PICKED);
    expect(list[list.length - 1]).toBe(gid(1000));
    expect(leftOver).toBe(1);
  });
});
