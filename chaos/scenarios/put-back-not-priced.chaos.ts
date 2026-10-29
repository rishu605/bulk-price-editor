/**
 * "Put it back" on a variant the campaign no longer prices leaves the drift open (#1042).
 *
 * The put-back plans the campaign for the drifted variant. One archived since, excluded,
 * or skipped by the plan has nothing planned, and nothing planned read as "the storefront
 * already shows the campaign's price": the event closed as put back while the merchant's
 * edit stayed live.
 *
 * Through the real `reassertDrift`, and the drift page's bulk decision.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { reassertDrift } from "../../app/services/campaigns/reassert.server";
import { decideDrift } from "../../app/services/drift-queue.server";
import { chaosAdminClient } from "../harness/http-client";
import { type ChaosContext, withChaos } from "../harness/scenario";

const CATALOG = { catalog: { products: 3, variantsPerProduct: 1 }, percent: -30 } as const;

/** The merchant's hand edit to `price` (minor units), recorded as drift on a held campaign. */
async function handEdit(chaos: ChaosContext, variantGid: string, price: number) {
  const { shopId, campaignId } = chaos.fixture;
  const sale = chaos.fake.priceOf(variantGid)!;
  chaos.fake.variants.get(variantGid)!.price = (price / 100).toFixed(2);
  await prisma.priceSurfaceEntry.updateMany({ where: { shopId, variantGid, surfaceKind: "BASE" }, data: { livePrice: BigInt(price) } });
  await prisma.campaign.update({ where: { id: campaignId }, data: { status: "HELD" } });
  return prisma.driftEvent.create({
    data: {
      shopId,
      variantGid,
      surfaceKind: "BASE",
      campaignId,
      observedPrice: BigInt(price),
      expectedPrice: BigInt(Math.round(Number(sale) * 100)),
      currency: "USD",
    },
  });
}

const resolutionOf = async (id: string) => (await prisma.driftEvent.findUniqueOrThrow({ where: { id } })).resolution;

describe("chaos: putting back a price the campaign no longer sets", () => {
  it("refuses an archived variant by name and keeps the drift open, then puts it back once it is active again", async () => {
    await withChaos("put-back-archived", CATALOG, async (chaos) => {
      const { shopId, campaignId, variantGids } = chaos.fixture;
      const [archived] = variantGids;
      const client = chaosAdminClient(chaos.server.endpoint());
      await chaos.expectHonest((await chaos.apply()).runId);
      const sale = chaos.fake.priceOf(archived);

      await prisma.variantIndex.updateMany({ where: { shopId, variantGid: archived }, data: { status: "ARCHIVED" } });
      const event = await handEdit(chaos, archived, 123);
      const runsBefore = await prisma.campaignRun.count({ where: { campaignId } });

      await expect(reassertDrift(shopId, event.id, client, "staff:1")).rejects.toThrow(/archived now.*prices only active products/);
      expect(await resolutionOf(event.id), "the drift closed with the edit still live").toBe("PENDING");
      expect(chaos.fake.priceOf(archived)).toBe("1.23");
      expect(await prisma.campaignRun.count({ where: { campaignId } }), "a refused put-back started a run").toBe(runsBefore);

      // Back in the campaign's products, the same press writes the campaign's price.
      await prisma.variantIndex.updateMany({ where: { shopId, variantGid: archived }, data: { status: "ACTIVE" } });
      const answer = await reassertDrift(shopId, event.id, client, "staff:1");
      expect(answer.ok).toBe(true);
      expect(chaos.fake.priceOf(archived)).toBe(sale);
      expect(await resolutionOf(event.id)).toBe("REASSERTED");
    });
  });

  it("keeps the drift open when the plan skips the variant", async () => {
    await withChaos("put-back-skipped", CATALOG, async (chaos) => {
      const { shopId, variantGids } = chaos.fixture;
      const [skipped] = variantGids;
      const client = chaosAdminClient(chaos.server.endpoint());
      await chaos.expectHonest((await chaos.apply()).runId);

      // A baseline in another currency: the planner never converts, so it skips the row.
      await prisma.baseline.updateMany({ where: { shopId, variantGid: skipped, supersededAt: null }, data: { currency: "EUR" } });
      const event = await handEdit(chaos, skipped, 123);

      const answer = await reassertDrift(shopId, event.id, client, "staff:1");
      expect(answer.ok).toBe(false);
      expect(answer.message).toMatch(/left .* alone, so nothing was written and the drift stays open/);
      expect(await resolutionOf(event.id), "the drift closed with the edit still live").toBe("PENDING");
      expect(chaos.fake.priceOf(skipped)).toBe("1.23");
    });
  });

  it("puts back the ones it prices in bulk and leaves the archived and excluded ones waiting", async () => {
    await withChaos("put-back-bulk-not-priced", CATALOG, async (chaos) => {
      const { shopId, campaignId, variantGids } = chaos.fixture;
      const [archived, priced, excluded] = variantGids;
      const client = chaosAdminClient(chaos.server.endpoint());
      await chaos.expectHonest((await chaos.apply()).runId);
      const sale = chaos.fake.priceOf(priced);

      await prisma.variantIndex.updateMany({ where: { shopId, variantGid: archived }, data: { status: "ARCHIVED" } });
      await prisma.campaign.update({ where: { id: campaignId }, data: { excludedVariantGids: [excluded] } });
      const events = [await handEdit(chaos, archived, 123), await handEdit(chaos, priced, 124), await handEdit(chaos, excluded, 125)];

      // The page the merchant decided on was loaded after all three edits. Not `new Date()`:
      // `detectedAt` is stored to the millisecond, rounded, so the last edit can land after a
      // clock read straight after it, and the decision then leaves it out (#1128).
      const asOf = new Date(events.at(-1)!.detectedAt.getTime() + 1).toISOString();
      const decided = await decideDrift(shopId, { campaignId, resolution: "reassert", asOf }, "staff:1", client);
      expect(decided.ok).toBe(false);
      expect(decided.message).toMatch(/Put back 1 price/);
      expect(decided.message).toMatch(/2 prices weren't put back/);

      expect(chaos.fake.priceOf(priced)).toBe(sale);
      expect(chaos.fake.priceOf(archived)).toBe("1.23");
      expect(chaos.fake.priceOf(excluded)).toBe("1.25");
      expect(await Promise.all(events.map((event) => resolutionOf(event.id)))).toEqual(["PENDING", "REASSERTED", "PENDING"]);
      expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status, "released with two still waiting").toBe("HELD");
    });
  });
});
