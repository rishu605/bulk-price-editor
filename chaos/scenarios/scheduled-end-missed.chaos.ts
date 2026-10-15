/**
 * A scheduled end whose revert cannot run is said once, by email and on the campaign, in
 * the merchant's words (#1005).
 *
 * The revert is retried every tick, rightly -- the sale's prices are live past its window --
 * but nobody was told: the release was quiet after the first (#975), no email went out, the
 * page said the campaign was running as planned, and the one history entry carried the raw
 * error text.
 *
 * Driven through the real `tick`, with the shop's guardrails unreadable the way an
 * unreachable database makes them (as `scheduled-refused-for-good` does).
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { endMissed } from "../../app/lib/scheduling/end-missed";
import type { Notification } from "../../app/lib/notifications/templates";
import { tick } from "../../app/services/scheduler.server";
import { fixtureAdminClient, withChaos } from "../harness/scenario";

let endpoint = "";
vi.mock("../../app/services/admin-client.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/services/admin-client.server")>();
  return { ...actual, adminClientForShop: async (domain: string) => fixtureAdminClient(domain, endpoint) };
});

const sent: Array<{ shopId: string; notification: Notification }> = [];
vi.mock("../../app/services/notifications.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../app/services/notifications.server")>()),
  notify: async (shopId: string, notification: Notification) => {
    sent.push({ shopId, notification });
    return { sent: true };
  },
}));

let databaseDown = false;
vi.mock("../../app/services/settings.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/services/settings.server")>();
  return {
    ...actual,
    guardrailsFor: async (shopId: string) => {
      if (databaseDown) {
        throw Object.assign(new Error("Can't reach database server at `db:5432`"), {
          name: "PrismaClientKnownRequestError",
          code: "P1001",
        });
      }
      return actual.guardrailsFor(shopId);
    },
  };
});

describe("chaos: a scheduled end that cannot run", () => {
  it("is retried, said once by email and on the campaign, and never in raw error text", async () => {
    await withChaos("scheduled-end-missed", { catalog: { products: 2, variantsPerProduct: 1 }, percent: -20 }, async (chaos) => {
      const { shopId, campaignId } = chaos.fixture;
      endpoint = chaos.server.endpoint();
      await chaos.expectHonest((await chaos.apply()).runId);

      // A window that ended five minutes ago: the next tick reverts it.
      const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
      const startAt = new Date(Date.now() - 2 * 60 * 60_000);
      const endAt = new Date(Date.now() - 5 * 60_000);
      await prisma.campaign.update({
        where: { id: campaignId },
        data: {
          status: "ACTIVE",
          startAt,
          endAt,
          schedule: { ...(campaign.schedule as object), kind: "window", startAt: startAt.toISOString(), endAt: endAt.toISOString() } as never,
        },
      });

      databaseDown = true;
      sent.length = 0;
      for (let i = 0; i < 2; i++) await tick(new Date());
      databaseDown = false;

      const after = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
      expect(after.status, "a failed end left the campaign somewhere other than where it was").toBe("ACTIVE");
      const reason = endMissed(after.schedule);
      expect(reason, "the missed end was not recorded").toBeTruthy();
      expect(reason).not.toMatch(/db:5432|Can't reach database server/);

      const emails = sent.filter((entry) => entry.shopId === shopId && entry.notification.kind === "run-failed");
      expect(emails, "the merchant was not told, or was told every tick").toHaveLength(1);
      expect((emails[0].notification as { notEnded?: boolean }).notEnded).toBe(true);

      const history = await prisma.auditLogEntry.findMany({
        where: { shopId, entityId: campaignId, action: "campaign.transition" },
        select: { after: true },
      });
      const reasons = history.map((row) => (row.after as { reason?: string } | null)?.reason ?? "");
      expect(reasons.some((text) => /db:5432|Can't reach database server/.test(text)), "raw error text in the history").toBe(false);

      // Once the blip passes, the next tick ends the sale.
      await tick(new Date());
      expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status).toBe("COMPLETED");
    });
  });
});
