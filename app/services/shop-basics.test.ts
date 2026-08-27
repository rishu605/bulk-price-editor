/**
 * Recognising a development store.
 *
 * `billingFrom` has always granted a development store the top tier and marked it exempt.
 * Nothing ever set the flag, so that branch was unreachable and every development store
 * fell to Free and its 500-variant cap — including the ones Shopify's own reviewers
 * evaluate on, whose first campaign over 500 variants would have been refused with a
 * message about upgrading.
 *
 * The failure mode to guard against now is the opposite one. Handing out the top tier
 * because a query failed, or because Shopify stopped returning the field, would give every
 * shop unlimited variants for free. So the check is deliberately `=== true` rather than
 * truthiness, and everything else — absent, null, missing, a failed request — reads as a
 * normal store.
 */

import { describe, expect, it } from "vitest";

import { fetchShopBasics } from "./catalog-sync.server";

/** The shape `client.graphql` returns: something with a `json()`. */
function runner(shop: unknown) {
  return {
    graphql: async () => ({ json: async () => ({ data: { shop } }) }),
  } as never;
}

describe("recognising a development store", () => {
  it("reads partnerDevelopment when Shopify says true", async () => {
    const basics = await fetchShopBasics(
      runner({ currencyCode: "USD", ianaTimezone: "UTC", plan: { partnerDevelopment: true } }),
    );
    expect(basics.developerStore).toBe(true);
  });

  it("is a normal store when Shopify says false", async () => {
    const basics = await fetchShopBasics(
      runner({ currencyCode: "USD", ianaTimezone: "UTC", plan: { partnerDevelopment: false } }),
    );
    expect(basics.developerStore).toBe(false);
  });

  it.each([
    ["no plan at all", { currencyCode: "USD", ianaTimezone: "UTC" }],
    ["a null plan", { currencyCode: "USD", ianaTimezone: "UTC", plan: null }],
    ["a plan without the field", { currencyCode: "USD", ianaTimezone: "UTC", plan: {} }],
    ["no shop in the response", undefined],
  ])("does not hand out the top tier on %s", async (_label, shop) => {
    const basics = await fetchShopBasics(runner(shop));
    expect(
      basics.developerStore,
      "an absent answer must read as a normal store, not a free upgrade",
    ).toBe(false);
  });

  it("still reads currency and timezone", async () => {
    const basics = await fetchShopBasics(
      runner({ currencyCode: "JPY", ianaTimezone: "Asia/Tokyo", plan: { partnerDevelopment: true } }),
    );
    expect(basics).toEqual({ currency: "JPY", timezone: "Asia/Tokyo", developerStore: true });
  });

  it("falls back sensibly when currency and timezone are missing", async () => {
    const basics = await fetchShopBasics(runner({}));
    expect(basics).toEqual({ currency: "USD", timezone: "UTC", developerStore: false });
  });
});
