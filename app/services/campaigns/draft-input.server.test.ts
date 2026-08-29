/**
 * The two ways into the preview describe the same campaign.
 *
 * There are two now. The resource route the editor's fetcher posts to reads a
 * `FormData`; the editor's loader prices the unedited form from a `URLSearchParams` it
 * builds, so the panel arrives populated rather than empty. Rule 4 says preview and
 * execution share one code path — two readings of the same fields is how that stops
 * being true without anything failing.
 *
 * The failure it would produce is the quiet kind: a merchant loads the editor, sees the
 * sidebar say one thing, types a single character, and watches the number change without
 * having changed the rule.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("../../db.server", () => ({
  default: { segment: { findFirst: vi.fn(async () => null) } },
}));

import { draftCampaignFrom } from "./draft-input.server";
import { DRAFT_DEFAULTS, draftDefaultParams } from "../../lib/campaigns/draft-defaults";

const SHOP = "shop_1";

/** The same fields, as the two shapes the two callers hold them in. */
function bothShapes(fields: Record<string, string>) {
  const params = new URLSearchParams(fields);
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return { params, form };
}

describe("a form and a query string describe the same draft", () => {
  it("agrees on the unedited defaults", async () => {
    const fields = Object.fromEntries(draftDefaultParams());
    const { params, form } = bothShapes(fields);

    expect(await draftCampaignFrom(SHOP, form, "USD")).toEqual(
      await draftCampaignFrom(SHOP, params, "USD"),
    );
  });

  it("agrees on a scoped campaign with rounding and a priority", async () => {
    const { params, form } = bothShapes({
      ruleKind: "percent-change",
      ruleValue: "-35",
      compareAt: "clear",
      collection: "Outerwear",
      tag: "sale",
      priority: "7",
      "rounding.default": "charm99",
      "rounding.JPY": "whole",
    });

    expect(await draftCampaignFrom(SHOP, form, "USD")).toEqual(
      await draftCampaignFrom(SHOP, params, "USD"),
    );
  });
});

describe("what the defaults actually price", () => {
  it("reads the default rule as a percent change off the baseline", async () => {
    const draft = await draftCampaignFrom(SHOP, draftDefaultParams(), "USD");

    expect(draft.rule).toEqual({
      kind: "percent-change",
      percent: Number(DRAFT_DEFAULTS.percentValue),
    });
    expect(draft.compareAtPolicy).toEqual({ kind: "set-to-baseline" });
    expect(draft.priority).toBe(Number(DRAFT_DEFAULTS.priority));
  });

  it("targets the whole catalogue when no filter is set", async () => {
    const draft = await draftCampaignFrom(SHOP, draftDefaultParams(), "USD");

    // An empty filter is every variant, not none — the editor says so in its own copy.
    expect(draft.ast).toEqual({ groups: [] });
  });

  it("builds a fixed amount in the shop's currency, not in dollars", async () => {
    // #343: the form has no currency field, so this used to be `?? "USD"` on every store
    // and the minor-unit conversion used a literal 100. A JPY "3000" became 300,000 USD.
    const jpy = await draftCampaignFrom(
      SHOP,
      new URLSearchParams({ ruleKind: "fixed-change", ruleValue: "-3000" }),
      "JPY",
    );

    expect(jpy.rule).toEqual({
      kind: "fixed-change",
      amount: { amount: -3000, currency: "JPY" },
    });
  });
});
