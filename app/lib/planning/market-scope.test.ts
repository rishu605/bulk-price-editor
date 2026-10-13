import { describe, expect, it } from "vitest";

import { marketScope } from "./market-scope";

const row = (variantGid: string, status: string, campaignId = "c") => ({ ref: { variantGid }, status, campaignId });
const unchanged = (variantGid: string, campaignId = "c") => ({ ref: { variantGid }, campaignId });

describe("the variants a campaign's markets are planned over", () => {
  it("includes a variant already at its price, which the plan's rows leave out (#841)", () => {
    expect(marketScope("c", [row("v1", "pending")], [unchanged("v2")])).toEqual(["v1", "v2"]);
  });

  it("includes the variants whose base price it writes, clamped ones too", () => {
    expect(marketScope("c", [row("v1", "pending"), row("v2", "clamped")], [])).toEqual(["v1", "v2"]);
  });

  it("leaves out a variant the plan set aside", () => {
    expect(marketScope("c", [row("v1", "skipped"), row("v2", "pending")], [])).toEqual(["v2"]);
  });

  it("leaves out every variant another campaign wins, written or not (#937)", () => {
    expect(marketScope("c", [row("v1", "pending", "above")], [unchanged("v2", "above"), unchanged("v3")])).toEqual(["v3"]);
  });

  it("names each variant once", () => {
    expect(marketScope("c", [row("v1", "pending")], [unchanged("v1")])).toEqual(["v1"]);
  });
});
