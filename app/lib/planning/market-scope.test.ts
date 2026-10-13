import { describe, expect, it } from "vitest";

import { marketScope } from "./market-scope";

const candidate = (variantGid: string) => ({ ref: { variantGid } });
const row = (variantGid: string, status: string) => ({ ref: { variantGid }, status });

describe("the variants a campaign's markets are planned over", () => {
  it("includes a variant already at its base price, which the plan's rows leave out (#841)", () => {
    // v2 is in scope and already correct on the base surface: no row at all.
    expect(marketScope([candidate("v1"), candidate("v2")], [row("v1", "pending")])).toEqual(["v1", "v2"]);
  });

  it("includes the variants whose base price is written, clamped ones too", () => {
    expect(marketScope([candidate("v1"), candidate("v2")], [row("v1", "pending"), row("v2", "clamped")])).toEqual(["v1", "v2"]);
  });

  it("leaves out a variant the plan set aside, as every surface always has", () => {
    expect(marketScope([candidate("v1"), candidate("v2")], [row("v1", "skipped"), row("v2", "pending")])).toEqual(["v2"]);
  });

  it("names each variant once", () => {
    expect(marketScope([candidate("v1"), candidate("v1")], [])).toEqual(["v1"]);
  });
});
