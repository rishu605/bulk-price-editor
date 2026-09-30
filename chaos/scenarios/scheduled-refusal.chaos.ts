/**
 * A scheduled campaign refused when its start arrives (#701).
 *
 * The scheduler claims a due window campaign (SCHEDULED → APPLYING) and calls
 * `runCampaign`. Three refusals in there -- waiting for approval, over the inline row
 * limit, refused by the plan -- are early returns, not throws, so nothing released the
 * claim. The campaign stayed APPLYING with no run behind it: the sale never started,
 * approving it afterwards changed nothing, nothing reverted it at the window's end, Home
 * counted it as running, and the tick reported it as applied.
 *
 * Driven through the real `tick`; only `adminClientForShop` is replaced, because the
 * fixture shop has no Shopify session.
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { tick } from "../../app/services/scheduler.server";
import { chaosAdminClient } from "../harness/http-client";
import { withChaos, type ChaosContext } from "../harness/scenario";

let endpoint = "";

vi.mock("../../app/services/admin-client.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/services/admin-client.server")>();
  return { ...actual, adminClientForShop: async () => chaosAdminClient(endpoint) };
});

/** A window campaign whose start has just passed, still SCHEDULED. */
async function dueToStart(chaos: ChaosContext) {
  endpoint = chaos.server.endpoint();
  const { campaignId } = chaos.fixture;
  const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
  const startAt = new Date(Date.now() - 5 * 60_000);
  const endAt = new Date(Date.now() + 24 * 60 * 60_000);
  await prisma.campaign.update({
    where: { id: campaignId },
    data: {
      status: "SCHEDULED",
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
}

const statusOf = async (id: string) =>
  (await prisma.campaign.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;

const releases = (shopId: string, campaignId: string) =>
  prisma.auditLogEntry.findMany({
    where: { shopId, entityId: campaignId, action: "campaign.transition" },
    select: { after: true },
  }).then((rows) =>
    rows
      .map((row) => (row.after as { reason?: string }).reason ?? "")
      .filter((reason) => reason.startsWith("claim released without running")),
  );

describe("chaos: a scheduled campaign refused at its start", () => {
  it("goes back to SCHEDULED while it waits for approval, and applies on the tick after approval", async () => {
    await withChaos(
      "scheduled-refusal-approval",
      { catalog: { products: 8, variantsPerProduct: 1 }, percent: -30 },
      async (chaos) => {
        const { shopId, campaignId, variantGids, baseline } = chaos.fixture;
        const shop = await prisma.shop.findUniqueOrThrow({ where: { id: shopId } });
        await prisma.shop.update({
          where: { id: shopId },
          data: { settings: { ...((shop.settings ?? {}) as object), approvalThreshold: 5 } as never },
        });
        const { requestApproval, decideApproval } = await import("../../app/services/approvals.server");
        await requestApproval(shopId, campaignId, "alice@example.com");
        await dueToStart(chaos);

        const first = await tick(new Date());
        expect(await statusOf(campaignId), "claimed and left APPLYING with nothing behind it").toBe(
          "SCHEDULED",
        );
        expect(first.applied, "a refused run counted as applied").toBe(0);
        expect(first.refused).toBe(1);

        // Visible on the campaign, once, however many ticks ask again while it waits.
        await tick(new Date());
        await tick(new Date());
        const said = await releases(shopId, campaignId);
        expect(said).toHaveLength(1);
        expect(said[0]).toMatch(/waiting for approval/);
        expect(await prisma.campaignRun.count({ where: { campaignId } })).toBe(0);

        // Approved after its start: the very next tick applies it.
        await decideApproval(shopId, campaignId, "bob@example.com", "approve");
        const after = await tick(new Date());
        expect(after.applied).toBe(1);
        expect(await statusOf(campaignId)).toBe("ACTIVE");
        for (const gid of variantGids) {
          expect(chaos.fake.priceOf(gid)).toBe((Math.round(baseline.get(gid)! * 0.7) / 100).toFixed(2));
        }
      },
    );
  });

  it("goes back to SCHEDULED when the plan refuses it, and says why", async () => {
    await withChaos(
      "scheduled-refusal-plan",
      { catalog: { products: 3, variantsPerProduct: 1 }, percent: -30 },
      async (chaos) => {
        const { shopId, campaignId } = chaos.fixture;

        // Markets are not part of Free: a lapsed or downgraded shop hits this at start time.
        const priceListGid = "gid://shopify/PriceList/scheduled-refusal";
        await prisma.priceListRecord.create({
          data: { shopId, priceListGid, name: "Europe", currency: "EUR", surfaceKind: "MARKET" },
        });
        await prisma.campaign.update({
          where: { id: campaignId },
          data: { surfaces: { base: true, priceLists: [priceListGid] } as never },
        });
        await prisma.shop.update({ where: { id: shopId }, data: { planTier: "FREE" } });
        await dueToStart(chaos);

        const result = await tick(new Date());

        // Per campaign, not per tick: `tick` scans every shop, and a fixture another
        // scenario left behind on failure would otherwise be counted here too.
        expect(await statusOf(campaignId)).toBe("SCHEDULED");
        expect(result.refused).toBeGreaterThanOrEqual(1);
        expect(await prisma.campaignRun.count({ where: { campaignId } })).toBe(0);
        const said = await releases(shopId, campaignId);
        expect(said).toHaveLength(1);
        expect(said[0]).toMatch(/Free/);
      },
    );
  });
});
