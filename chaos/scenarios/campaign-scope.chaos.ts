/**
 * Two campaigns with different scopes, both active (#752).
 *
 * Every other ACTIVE campaign was offered to the planner without its scope, and a rule
 * row with no segments matches everything -- so an active campaign was treated as
 * covering the whole store. A narrow, high-priority sale on one product priced the whole
 * catalogue whenever a broad campaign ran, and ending one sale handed products to a sale
 * that was never set up for them.
 *
 * Through the real engine: a narrow campaign (-50%, priority 1000, one product), then the
 * fixture's broad one (-20%, priority 900, all three), then each reverted.
 */

import { describe, expect, it } from "vitest";

import { createCampaign } from "../../app/services/campaigns/model.server";
import { runCampaign } from "../../app/services/campaigns/run.server";
import { createSegment } from "../../app/services/segments-crud.server";
import { chaosAdminClient } from "../harness/http-client";
import { withChaos } from "../harness/scenario";

const at = (minor: number, factor: number) => (Math.round(minor * factor) / 100).toFixed(2);

describe("chaos: two active campaigns with different scopes", () => {
  it("prices each product by the campaigns that cover it, on apply and on revert", async () => {
    await withChaos("campaign-scope", { catalog: { products: 3, variantsPerProduct: 1 }, percent: -20 }, async (chaos) => {
      const { shopId, campaignId: broadId, variantGids, baseline } = chaos.fixture;
      const [one, two, three] = variantGids;
      const client = chaosAdminClient(chaos.server.endpoint());
      const prices = () => variantGids.map((gid) => chaos.fake.priceOf(gid));

      const onlyOne = await createSegment(shopId, { name: `scope-${chaos.seed}`, kind: "FROZEN", variantGids: [one] });
      const narrow = await createCampaign(shopId, {
        name: "chaos/campaign-scope narrow",
        priority: 1000,
        rule: { kind: "percent-change", percent: -50 },
        compareAtPolicy: { kind: "leave" },
        rounding: { default: "none", byCurrency: {} },
        ast: { groups: [] },
        segmentId: onlyOne.id,
        schedule: { kind: "manual" },
      });

      const narrowRun = await runCampaign(shopId, narrow.id, client, {});
      expect(narrowRun.verified).toBe(1);
      expect(prices()).toEqual([at(baseline.get(one)!, 0.5), at(baseline.get(two)!, 1), at(baseline.get(three)!, 1)]);

      // The broad campaign runs. Product 1 stays with the narrow one, which outranks it;
      // products 2 and 3 are the broad campaign's, and get its 20%, not the narrow 50%.
      const broadRun = await chaos.apply();
      expect(prices(), "the narrow campaign priced products outside its scope").toEqual([
        at(baseline.get(one)!, 0.5),
        at(baseline.get(two)!, 0.8),
        at(baseline.get(three)!, 0.8),
      ]);
      expect(broadRun.verified).toBe(2);

      // Ending the narrow sale hands product 1 to the broad one, and touches nothing else.
      await runCampaign(shopId, narrow.id, client, { revert: true });
      expect(prices()).toEqual([at(baseline.get(one)!, 0.8), at(baseline.get(two)!, 0.8), at(baseline.get(three)!, 0.8)]);

      // Ending the broad one returns everything to baseline: nothing else covers them now.
      await runCampaign(shopId, broadId, client, { revert: true });
      expect(prices()).toEqual([at(baseline.get(one)!, 1), at(baseline.get(two)!, 1), at(baseline.get(three)!, 1)]);
    });
  });

  it("does not hand a reverted broad campaign's products to a narrow one that does not cover them", async () => {
    await withChaos("campaign-scope-revert", { catalog: { products: 3, variantsPerProduct: 1 }, percent: -20 }, async (chaos) => {
      const { shopId, campaignId: broadId, variantGids, baseline } = chaos.fixture;
      const [one, two, three] = variantGids;
      const client = chaosAdminClient(chaos.server.endpoint());

      await chaos.apply();
      const onlyOne = await createSegment(shopId, { name: `scope-r-${chaos.seed}`, kind: "FROZEN", variantGids: [one] });
      const narrow = await createCampaign(shopId, {
        name: "chaos/campaign-scope-revert narrow",
        priority: 100,
        rule: { kind: "percent-change", percent: -50 },
        compareAtPolicy: { kind: "leave" },
        rounding: { default: "none", byCurrency: {} },
        ast: { groups: [] },
        segmentId: onlyOne.id,
        schedule: { kind: "manual" },
      });
      await runCampaign(shopId, narrow.id, client, {});

      // The broad one ends. Product 1 falls to the narrow sale that covers it; 2 and 3
      // return to full price rather than taking the narrow sale's 50%.
      await runCampaign(shopId, broadId, client, { revert: true });
      expect(variantGids.map((gid) => chaos.fake.priceOf(gid)), "ending one sale put products on another").toEqual([
        at(baseline.get(one)!, 0.5),
        at(baseline.get(two)!, 1),
        at(baseline.get(three)!, 1),
      ]);
    });
  });
});
