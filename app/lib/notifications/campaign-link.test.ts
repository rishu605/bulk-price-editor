import { describe, expect, it } from "vitest";

import { campaignUrl, driftUrl } from "./campaign-link";

const KEY = "5401aeddaf37aac5c9e1650bf6abb462";

describe("campaignUrl", () => {
  it("enters the app through the admin, not through our own host", () => {
    // Our own URL loads the app outside the admin frame — no host, no id_token, no
    // session — and the merchant lands on an authentication error rather than on the
    // partial run the email was about.
    expect(campaignUrl("boltify-apps.myshopify.com", "c1", KEY)).toBe(
      `https://admin.shopify.com/store/boltify-apps/apps/${KEY}/app/campaigns/c1`,
    );
  });

  it("gives nothing rather than a guess when the app is not configured", () => {
    // Local development and self-hosted installs have no key. A link that will not load
    // is worse than the missing line it replaces.
    expect(campaignUrl("boltify-apps.myshopify.com", "c1", undefined)).toBeUndefined();
    expect(campaignUrl("boltify-apps.myshopify.com", "c1", "")).toBeUndefined();
  });

  it("gives nothing when it has no campaign or no shop to point at", () => {
    expect(campaignUrl("boltify-apps.myshopify.com", "", KEY)).toBeUndefined();
    expect(campaignUrl("", "c1", KEY)).toBeUndefined();
  });

  it("takes the store name off the domain, and only from the end", () => {
    // A store legitimately called "myshopify-tools" keeps its name.
    expect(campaignUrl("myshopify-tools.myshopify.com", "c1", KEY)).toContain(
      "/store/myshopify-tools/",
    );
  });
});

describe("driftUrl", () => {
  it("points at the queue, because drift is about no single campaign", () => {
    expect(driftUrl("boltify-apps.myshopify.com", KEY)).toBe(
      `https://admin.shopify.com/store/boltify-apps/apps/${KEY}/app/prices/drift`,
    );
  });

  it("is silent when unconfigured, like every other link here", () => {
    expect(driftUrl("boltify-apps.myshopify.com", undefined)).toBeUndefined();
  });
});
