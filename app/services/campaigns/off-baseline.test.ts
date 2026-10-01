import { describe, expect, it } from "vitest";

import { money } from "../../lib/money/money";
import { offBaseline } from "./off-baseline";

const usd = (n: number) => money(n, "USD");
const ref = (variantGid: string, priceListGid = "") => ({ variantGid, surfaceKind: "base" as const, priceListGid, currency: "USD" });

describe("rows whose live price is not their baseline (#745)", () => {
  const candidates = [
    { ref: ref("a"), baseline: { price: usd(1_000) } },
    { ref: ref("b"), baseline: { price: usd(2_000) } },
    { ref: ref("c"), baseline: { price: usd(3_000) } },
  ];

  it("finds the rows whose live price differs, from what the plan already holds", () => {
    const rows = [
      { ref: ref("a"), beforePrice: usd(1_000) },
      { ref: ref("b"), beforePrice: usd(1_500) },
      { ref: ref("c") },
    ];
    expect(offBaseline(rows, candidates)).toEqual(["b"]);
  });

  it("ignores market rows and variants with no baseline", () => {
    expect(offBaseline([{ ref: ref("a", "gid://shopify/PriceList/1"), beforePrice: usd(1) }], candidates)).toEqual([]);
    expect(offBaseline([{ ref: ref("z"), beforePrice: usd(1) }], candidates)).toEqual([]);
  });
});
