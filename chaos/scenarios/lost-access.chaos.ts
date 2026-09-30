/**
 * Background work for a store Anchor has no usable session for (#707).
 *
 * With the refresh in place this is a store that revoked Anchor's access or uninstalled
 * it, not one that merely had nobody open the app for an hour. What matters is that the
 * work waits and says why, instead of vanishing:
 *
 *   The enrollment drain cleared a campaign's "newly enrolled variants" mark before
 *   fetching a client, so when there was none the variants were dropped for good.
 *
 *   A due scheduled start failed only in the tick log; the campaign sat SCHEDULED past
 *   its start with nothing on it to say why.
 *
 * Driven through the real `tick`, with `adminClientForShop` answering "no session".
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { tick } from "../../app/services/scheduler.server";
import { withChaos } from "../harness/scenario";

vi.mock("../../app/services/admin-client.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/services/admin-client.server")>();
  return { ...actual, adminClientForShop: async () => null };
});

describe("chaos: a store with no usable session", () => {
  it("keeps the enrollment mark, so the variants are priced once access is back", async () => {
    await withChaos(
      "lost-access-enrollment",
      { catalog: { products: 2, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const { campaignId } = chaos.fixture;
        await chaos.apply();
        const marked = new Date();
        await prisma.campaign.update({ where: { id: campaignId }, data: { enrollPendingAt: marked } });

        const result = await tick(new Date());

        const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
        expect(campaign.enrollPendingAt, "the enrolled variants were dropped").not.toBeNull();
        expect(result.failures.some((f) => f.campaignId === campaignId && /No usable session/.test(f.error))).toBe(true);
      },
    );
  });

  it("says on the campaign, once, why a due scheduled start could not run", async () => {
    await withChaos(
      "lost-access-schedule",
      { catalog: { products: 2, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const { shopId, campaignId } = chaos.fixture;
        const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
        const startAt = new Date(Date.now() - 5 * 60_000);
        await prisma.campaign.update({
          where: { id: campaignId },
          data: {
            status: "SCHEDULED",
            startAt,
            schedule: { ...(campaign.schedule as object), kind: "window", startAt: startAt.toISOString() } as never,
          },
        });

        await tick(new Date());
        await tick(new Date());

        expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status).toBe("SCHEDULED");
        const notes = (
          await prisma.auditLogEntry.findMany({
            where: { shopId, entityId: campaignId, action: "campaign.transition" },
            select: { after: true },
          })
        )
          .map((row) => (row.after as { reason?: string }).reason ?? "")
          .filter((reason) => reason.includes("lost access"));
        expect(notes).toHaveLength(1);
        expect(notes[0]).toMatch(/^Couldn't start on schedule: Anchor lost access to your store/);
      },
    );
  });
});
