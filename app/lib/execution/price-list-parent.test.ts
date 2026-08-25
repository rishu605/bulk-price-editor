/**
 * Reading and writing a price list's parent adjustment.
 *
 * The write moves every price on a market at once, so the tests that matter here are
 * about not believing it worked when it did not, and about reading Shopify's
 * signed-magnitude representation back as a single signed integer without losing the
 * sign — which is the difference between a 20% sale and a 20% price rise.
 */

import { describe, expect, it } from "vitest";

import { readParentState, setParentAdjustment, toBps } from "./price-list-parent";
import type { AdminClient } from "./sync-executor";

function clientReturning(data: unknown): AdminClient {
  return {
    async request<T>() {
      return { data: data as T };
    },
  };
}

describe("reading Shopify's adjustment as basis points", () => {
  it("makes a decrease negative and an increase positive", () => {
    expect(toBps({ type: "PERCENTAGE_DECREASE", value: 20 })).toBe(-2000);
    expect(toBps({ type: "PERCENTAGE_INCREASE", value: 20 })).toBe(2000);
  });

  it("keeps a fractional percentage exactly", () => {
    expect(toBps({ type: "PERCENTAGE_DECREASE", value: 12.33 })).toBe(-1233);
  });

  it("reads no parent at all as null, not as zero", () => {
    // The two revert differently: null means the merchant never set a percentage on
    // this market, and pinning it at 0% afterwards is not the same as leaving it alone.
    expect(toBps(null)).toBeNull();
    expect(toBps(undefined)).toBeNull();
    expect(toBps({ type: "PERCENTAGE_DECREASE" })).toBeNull();
  });
});

describe("reading a market's current state", () => {
  it("reports an existing percentage and any per-product overrides", async () => {
    const client = clientReturning({
      priceList: {
        parent: { adjustment: { type: "PERCENTAGE_DECREASE", value: 10 } },
        fixed: { nodes: [{ variant: { id: "gid://shopify/ProductVariant/1" } }] },
      },
    });

    expect(await readParentState(client, "gid://shopify/PriceList/eu")).toEqual({
      adjustmentBps: -1000,
      hasFixedOverrides: true,
    });
  });

  it("reports a clean relative market as having no overrides", async () => {
    const client = clientReturning({
      priceList: {
        parent: { adjustment: { type: "PERCENTAGE_INCREASE", value: 5 } },
        fixed: { nodes: [] },
      },
    });

    expect(await readParentState(client, "gid://shopify/PriceList/jp")).toEqual({
      adjustmentBps: 500,
      hasFixedOverrides: false,
    });
  });

  it("returns null for a market that no longer exists", async () => {
    // A merchant can delete a market between the campaign being saved and it running.
    // Null sends the caller down the per-product path rather than repricing something
    // on the strength of a missing answer.
    expect(await readParentState(clientReturning({ priceList: null }), "gone")).toBeNull();
  });
});

describe("setting a market's percentage", () => {
  it("reports success only when Shopify echoes the new adjustment back", async () => {
    const client = clientReturning({
      priceListUpdate: {
        priceList: { parent: { adjustment: { type: "PERCENTAGE_DECREASE", value: 28 } } },
        userErrors: [],
      },
    });

    expect(await setParentAdjustment(client, "gid://shopify/PriceList/eu", {
      type: "PERCENTAGE_DECREASE",
      value: 28,
    })).toEqual({ ok: true, appliedBps: -2800, errors: [] });
  });

  it("does not read silence as success", async () => {
    // No errors and no price list is Shopify telling us nothing. Calling that a
    // success would report a whole market repriced when it may not have been.
    const client = clientReturning({ priceListUpdate: { priceList: null, userErrors: [] } });

    const result = await setParentAdjustment(client, "gid://shopify/PriceList/eu", {
      type: "PERCENTAGE_DECREASE",
      value: 28,
    });

    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("did not report");
  });

  it("passes a rejection through in Shopify's own words", async () => {
    const client = clientReturning({
      priceListUpdate: {
        priceList: null,
        userErrors: [{ field: ["parent"], message: "Catalog does not support adjustments." }],
      },
    });

    const result = await setParentAdjustment(client, "gid://shopify/PriceList/eu", {
      type: "PERCENTAGE_DECREASE",
      value: 28,
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(["Catalog does not support adjustments."]);
  });
});
