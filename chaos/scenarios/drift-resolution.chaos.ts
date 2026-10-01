/**
 * Resolving a price drift from the queue, and what it does to the held campaign (#756).
 *
 * "Put it back" marked the event REASSERTED and promised that "the campaign will rewrite
 * this price on its next run". No run came: a manual campaign never runs by itself, and the
 * scheduler skipped HELD campaigns -- including their scheduled end. So the merchant made
 * the decision the app asked for, the queue emptied, the edit stayed on the storefront and
 * the campaign stayed Held for good. Keeping or leaving the change held it for good too.
 *
 * Edits arrive through the products webhook, as they really do; the scheduler is the real
 * `tick`. Only `authenticate.webhook` and `adminClientForShop` are replaced.
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { holdForDrift, transitionCampaign } from "../../app/services/campaigns/lifecycle.server";
import { reassertDrift } from "../../app/services/campaigns/reassert.server";
import { resolveDrift } from "../../app/services/drift.server";
import { tick } from "../../app/services/scheduler.server";
import { isVariantWrite } from "../harness/faults";
import { chaosAdminClient } from "../harness/http-client";
import { withChaos, type ChaosContext } from "../harness/scenario";

let pending: { shop: string; topic: string; payload: unknown; admin?: unknown } = { shop: "", topic: "", payload: {} };
let endpoint = "";

vi.mock("../../app/shopify.server", () => ({
  authenticate: { webhook: async () => pending },
}));

vi.mock("../../app/services/admin-client.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/services/admin-client.server")>();
  return { ...actual, adminClientForShop: async () => chaosAdminClient(endpoint) };
});

const webhookAdmin = {
  async graphql(_query: string, options?: { variables?: Record<string, unknown> }) {
    return { json: async () => ({ data: { product: { id: options?.variables?.id, isGiftCard: false } } }) };
  },
};

let clock = 60_000;

/** A merchant's edit in the Shopify admin: the store changes, then the webhook lands. */
async function merchantEdits(chaos: ChaosContext, variantGid: string, price: string) {
  chaos.fake.variants.get(variantGid)!.price = price;
  clock += 60_000;
  pending = {
    shop: chaos.fixture.domain,
    topic: "PRODUCTS_UPDATE",
    admin: webhookAdmin,
    payload: {
      admin_graphql_api_id: chaos.fixture.productOf.get(variantGid)!,
      title: "Drifted product",
      status: "active",
      // The seeded campaign selects on this tag. A real edit keeps the product's tags.
      tags: "chaos",
      updated_at: new Date(Date.now() + clock).toISOString(),
      variants: [{ admin_graphql_api_id: variantGid, title: "V", price, compare_at_price: null }],
      variant_gids: [{ admin_graphql_api_id: variantGid }],
    },
  };
  const { action } = await import("../../app/routes/webhooks.products");
  await action({ request: new Request("https://example.invalid/webhooks/products", { method: "POST" }) } as never);

  return prisma.driftEvent.findFirstOrThrow({
    where: { shopId: chaos.fixture.shopId, variantGid, resolution: "PENDING" },
  });
}

/** An applied campaign, with every row read back. Returns each variant's campaign price. */
async function applied(chaos: ChaosContext) {
  endpoint = chaos.server.endpoint();
  await chaos.expectHonest((await chaos.apply()).runId);
  return new Map(chaos.fixture.variantGids.map((gid) => [gid, chaos.fake.priceOf(gid)!]));
}

const statusOf = async (id: string) =>
  (await prisma.campaign.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;

const currentBaseline = (shopId: string, variantGid: string) =>
  prisma.baseline.findFirstOrThrow({ where: { shopId, variantGid, supersededAt: null } });

const CATALOG = { catalog: { products: 2, variantsPerProduct: 1 }, percent: -30 } as const;

describe("chaos: resolving price drift from the queue", () => {
  it("puts the price back now, and runs the campaign again once nothing else is waiting", async () => {
    await withChaos("drift-put-it-back", CATALOG, async (chaos) => {
      const { shopId, campaignId, variantGids } = chaos.fixture;
      const [first, second] = variantGids;
      const sale = await applied(chaos);

      const firstEdit = await merchantEdits(chaos, first, "1.23");
      expect(await statusOf(campaignId)).toBe("HELD");

      // A second edit while held. Seeded rather than delivered: once a campaign is held,
      // the webhook records nothing more for it (#878), so this is the state that fix
      // makes reachable -- two decisions pending on one held campaign.
      chaos.fake.variants.get(second)!.price = "4.56";
      await prisma.priceSurfaceEntry.updateMany({
        where: { shopId, variantGid: second, surfaceKind: "BASE" },
        data: { livePrice: 456n },
      });
      const secondEdit = await prisma.driftEvent.create({
        data: {
          shopId,
          variantGid: second,
          surfaceKind: "BASE",
          campaignId,
          observedPrice: 456n,
          expectedPrice: BigInt(Math.round(Number(sale.get(second)) * 100)),
          currency: "USD",
        },
      });

      const result = await reassertDrift(shopId, firstEdit.id, chaosAdminClient(endpoint), "staff@example.com");
      expect(result.ok, result.message).toBe(true);
      expect(chaos.fake.priceOf(first), "Put it back wrote nothing").toBe(sale.get(first));
      expect(result.message).toContain("written and read back");

      const event = await prisma.driftEvent.findUniqueOrThrow({ where: { id: firstEdit.id } });
      expect(event.resolution).toBe("REASSERTED");
      expect(event.resolvedBy).toBe("staff@example.com");
      const run = await prisma.campaignRun.findFirstOrThrow({
        where: { campaignId, occurrenceKey: { startsWith: "VARIANT-REASSERT-" } },
        include: { changes: true },
      });
      expect(run.status).toBe("COMPLETED");
      expect(run.changes.map((change) => [change.variantGid, change.status])).toEqual([[first, "VERIFIED"]]);

      // The other edit is still waiting, so the campaign is still held.
      expect(await statusOf(campaignId)).toBe("HELD");
      expect(chaos.fake.priceOf(second)).toBe("4.56");

      const { released } = await resolveDrift(shopId, secondEdit.id, "ignore", "staff@example.com");
      expect(released).toBe(true);
      expect(await statusOf(campaignId), "resolving the last drift left the campaign held").toBe("ACTIVE");
      expect(chaos.fake.priceOf(second), "Leave it for now changed the price").toBe("4.56");

      const transition = await prisma.auditLogEntry.findFirstOrThrow({
        where: { shopId, action: "campaign.transition", entityId: campaignId },
        orderBy: { createdAt: "desc" },
      });
      expect(transition.actor).toBe("staff@example.com");
      expect(transition.after).toMatchObject({ status: "ACTIVE", reason: "price drift resolved" });

      // A second answer to an answered question changes nothing.
      await expect(resolveDrift(shopId, firstEdit.id, "ignore")).rejects.toThrow(/already resolved/);
      expect((await prisma.driftEvent.findUniqueOrThrow({ where: { id: firstEdit.id } })).resolution).toBe(
        "REASSERTED",
      );
    });
  });

  it("keeps the change as the new baseline, and runs the campaign again", async () => {
    await withChaos("drift-keep-the-change", CATALOG, async (chaos) => {
      const { shopId, campaignId, variantGids } = chaos.fixture;
      await applied(chaos);

      const edit = await merchantEdits(chaos, variantGids[0], "7.89");
      expect(await statusOf(campaignId)).toBe("HELD");

      const { released } = await resolveDrift(shopId, edit.id, "adopt", "staff@example.com");
      expect(released).toBe(true);
      expect(await statusOf(campaignId)).toBe("ACTIVE");
      expect(Number((await currentBaseline(shopId, variantGids[0])).basePrice)).toBe(789);
      expect(chaos.fake.priceOf(variantGids[0])).toBe("7.89");
    });
  });

  it("leaves the question open when Shopify will not take the price", async () => {
    await withChaos("drift-put-back-refused", CATALOG, async (chaos) => {
      const { shopId, campaignId, variantGids, productOf } = chaos.fixture;
      const sale = await applied(chaos);
      const edit = await merchantEdits(chaos, variantGids[0], "1.23");

      chaos.arm([
        {
          fault: "server-error",
          match: (query, variables) => isVariantWrite(query) && variables.productId === productOf.get(variantGids[0]),
        },
      ]);
      const refused = await reassertDrift(shopId, edit.id, chaosAdminClient(endpoint), "staff@example.com");
      expect(refused.ok).toBe(false);
      expect(refused.message).toContain("did not confirm");
      expect((await prisma.driftEvent.findUniqueOrThrow({ where: { id: edit.id } })).resolution).toBe("PENDING");
      expect(await statusOf(campaignId), "a failed put-back released the hold").toBe("HELD");

      chaos.heal();
      const retried = await reassertDrift(shopId, edit.id, chaosAdminClient(endpoint), "staff@example.com");
      expect(retried.ok, retried.message).toBe(true);
      expect(chaos.fake.priceOf(variantGids[0])).toBe(sale.get(variantGids[0]));
      expect(await statusOf(campaignId)).toBe("ACTIVE");
    });
  });

  it("goes back to PARTIAL, not ACTIVE, when that is what it was held from", async () => {
    await withChaos("drift-held-from-partial", CATALOG, async (chaos) => {
      const { shopId, campaignId, variantGids } = chaos.fixture;
      await applied(chaos);
      await transitionCampaign(shopId, campaignId, "PARTIAL", { reason: "chaos: a row failed" });
      const event = await prisma.driftEvent.create({
        data: {
          shopId,
          variantGid: variantGids[0],
          surfaceKind: "BASE",
          campaignId,
          observedPrice: 123n,
          expectedPrice: 100n,
          currency: "USD",
        },
      });
      await holdForDrift(shopId, campaignId, variantGids[0]);
      expect(await statusOf(campaignId)).toBe("HELD");

      await resolveDrift(shopId, event.id, "ignore");
      expect(await statusOf(campaignId), "a partial run's unfinished rows were hidden behind ACTIVE").toBe("PARTIAL");
    });
  });

  it("still ends a held sale on its scheduled end date", async () => {
    await withChaos("drift-held-scheduled-end", CATALOG, async (chaos) => {
      const { shopId, campaignId, variantGids, baseline } = chaos.fixture;
      await applied(chaos);
      await merchantEdits(chaos, variantGids[0], "1.23");
      expect(await statusOf(campaignId)).toBe("HELD");

      const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
      const startAt = new Date(Date.now() - 2 * 60 * 60_000);
      const endAt = new Date(Date.now() - 60 * 60_000);
      await prisma.campaign.update({
        where: { id: campaignId },
        data: {
          startAt,
          endAt,
          schedule: {
            ...(campaign.schedule as object),
            kind: "window",
            startAt: startAt.toISOString(),
            endAt: endAt.toISOString(),
          } as never,
        },
      });

      await tick(new Date());
      expect(await statusOf(campaignId), "a held sale ran past its end").toBe("COMPLETED");
      for (const gid of variantGids) {
        expect(Number(chaos.fake.priceOf(gid)!.replace(".", "")), `${gid} not back at baseline`).toBe(baseline.get(gid));
      }

      // The revert wrote over the merchant's edit: said so, and the queue no longer asks.
      const revert = await prisma.campaignRun.findFirstOrThrow({ where: { campaignId, kind: "REVERT" } });
      const event = await prisma.driftEvent.findFirstOrThrow({ where: { shopId, variantGid: variantGids[0] } });
      expect(event.resolution).toBe("REASSERTED");
      expect(event.resolvedBy).toBe(`run:${revert.id}`);
      const audit = await prisma.auditLogEntry.findFirstOrThrow({ where: { shopId, action: "drift.overwritten" } });
      expect(audit.after).toMatchObject({ kind: "REVERT", events: 1 });
    });
  });
});
