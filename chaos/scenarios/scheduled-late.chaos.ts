/**
 * A scheduled campaign past its start that has not started says why, on its page (#851).
 *
 * Waiting for approval -- or refused by its plan -- the scheduler released it each tick
 * and recorded the reason once in its history, while the Status card, the first thing on
 * the page, still said "Waiting for its start time" over a window that had opened.
 *
 * Through the real `tick` and the campaign page's own loader.
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { type ChaosContext, fixtureAdminClient, withChaos } from "../harness/scenario";

let pending = { shop: "" };
let endpoint = "";

vi.mock("../../app/shopify.server", () => ({
  authenticate: {
    admin: async () => ({
      session: { shop: pending.shop },
      sessionToken: { sub: "42" },
      admin: {
        async graphql() {
          throw new Error("the page's loader made an Admin API call");
        },
      },
    }),
  },
}));

vi.mock("../../app/services/admin-client.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/services/admin-client.server")>();
  return { ...actual, adminClientForShop: async (domain: string) => fixtureAdminClient(domain, endpoint) };
});

async function statusCard(campaignId: string) {
  const { loader } = await import("../../app/routes/app.campaigns.$id");
  const page = (await loader({
    request: new Request(`https://example.invalid/app/campaigns/${campaignId}`),
    params: { id: campaignId },
    context: {},
  } as never)) as { lifecycle: { label: string; tone: string; explanation: string } };
  return page.lifecycle;
}

/** The fixture campaign, scheduled to start `startsIn` from now, needing an approval. */
async function scheduledNeedingApproval(chaos: ChaosContext, startsIn: number) {
  const { shopId, campaignId } = chaos.fixture;
  const shop = await prisma.shop.findUniqueOrThrow({ where: { id: shopId } });
  await prisma.shop.update({
    where: { id: shopId },
    data: { settings: { ...((shop.settings ?? {}) as object), approvalThreshold: 1 } as never },
  });
  const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
  const startAt = new Date(Date.now() + startsIn);
  const endAt = new Date(Date.now() + 24 * 60 * 60_000);
  await prisma.campaign.update({
    where: { id: campaignId },
    data: {
      status: "SCHEDULED",
      startAt,
      endAt,
      schedule: { ...(campaign.schedule as object), kind: "window", startAt: startAt.toISOString(), endAt: endAt.toISOString() } as never,
    },
  });
}

describe("chaos: a scheduled campaign that has not started", () => {
  it("says why on its Status card once its start has passed, and is still waiting before it", async () => {
    await withChaos("scheduled-late", { catalog: { products: 3, variantsPerProduct: 1 } }, async (chaos) => {
      const { domain, campaignId } = chaos.fixture;
      pending = { shop: domain };
      endpoint = chaos.server.endpoint();

      // Before its start: waiting, as before.
      await scheduledNeedingApproval(chaos, 60 * 60_000);
      expect((await statusCard(campaignId)).label).toBe("Scheduled");

      // Its start has passed and the scheduler could not run it: approval is needed.
      await scheduledNeedingApproval(chaos, -5 * 60_000);
      const { tick } = await import("../../app/services/scheduler.server");
      await tick(new Date());
      expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status).toBe("SCHEDULED");

      const card = await statusCard(campaignId);
      expect(card.label, "it still read as waiting for a start time that had come").toBe("Scheduled — not started yet");
      expect(card.tone).toBe("warning");
      expect(card.explanation).toMatch(/approv/i);
      expect(card.explanation).not.toMatch(/Waiting for its start time/);
    });
  });
});
