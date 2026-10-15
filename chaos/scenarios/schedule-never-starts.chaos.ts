/**
 * A scheduled campaign whose window can never open says so, in the list and on its page (#824).
 *
 * #883 refuses such a window when one is saved. One saved before that -- or a window that
 * closed while nothing applied it -- sat at "Scheduled · Waiting for its start time" for
 * ever, while the scheduler, checking the revert moment first, owed it nothing on every tick.
 *
 * Through the campaign list's own service and the real `tick`.
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { filtersFrom, listCampaigns } from "../../app/services/campaigns/list.server";
import { fixtureAdminClient, withChaos } from "../harness/scenario";

let endpoint = "";
vi.mock("../../app/services/admin-client.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/services/admin-client.server")>();
  return { ...actual, adminClientForShop: async (domain: string) => fixtureAdminClient(domain, endpoint) };
});

describe("chaos: a scheduled window that can never open", () => {
  it("is shown as will never start, and the scheduler leaves it alone", async () => {
    await withChaos("schedule-never-starts", { catalog: { products: 1, variantsPerProduct: 1 } }, async (chaos) => {
      const { shopId, campaignId } = chaos.fixture;
      endpoint = chaos.server.endpoint();
      // A window that closed yesterday, never applied.
      const startAt = new Date(Date.now() - 2 * 24 * 60 * 60_000);
      const endAt = new Date(Date.now() - 24 * 60 * 60_000);
      const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
      await prisma.campaign.update({
        where: { id: campaignId },
        data: {
          status: "SCHEDULED",
          startAt,
          endAt,
          schedule: { ...(campaign.schedule as object), kind: "window", startAt: startAt.toISOString(), endAt: endAt.toISOString() } as never,
        },
      });

      const { campaigns } = await listCampaigns(shopId, filtersFrom(new URLSearchParams()));
      const row = campaigns.find((r) => r.id === campaignId);
      expect(row?.lifecycle.label, "a window that can never open still reads as waiting").toBe("Scheduled — will never start");
      expect(row?.lifecycle.tone).toBe("warning");

      const { tick } = await import("../../app/services/scheduler.server");
      await tick(new Date());
      expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status).toBe("SCHEDULED");
    });
  });
});
