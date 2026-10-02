/**
 * Uninstalling leaves the merchant alone, and reinstalling brings them back (#786).
 *
 * `Shop.uninstalledAt` is the flag every background job reads to leave a departed shop
 * alone, and the uninstall webhook never set it. A merchant who removed the app kept
 * getting the weekly digest, and their due campaigns were attempted on every tick with no
 * session to attempt them with.
 *
 * Driven by the webhook, not by setting the flag by hand: the route's own action, with
 * only `authenticate.webhook` replaced. `adminClientForShop` is replaced with a recorder,
 * because "the job left this shop alone" means it never asked for its client.
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { sendDueDigests } from "../../app/services/digest.server";
import { fireTriggerForShop } from "../../app/services/flow.server";
import { writePreferences } from "../../app/services/notifications.server";
import { tick } from "../../app/services/scheduler.server";
import { ensureShop } from "../../app/services/shop.server";
import { withChaos } from "../harness/scenario";

let pending = { shop: "", session: null as unknown };
const asked: string[] = [];

vi.mock("../../app/shopify.server", () => ({
  authenticate: { webhook: async () => ({ shop: pending.shop, session: pending.session, topic: "APP_UNINSTALLED" }) },
}));

vi.mock("../../app/services/admin-client.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/services/admin-client.server")>();
  return {
    ...actual,
    adminClientForShop: async (domain: string) => {
      asked.push(domain);
      return null;
    },
  };
});

async function uninstall(domain: string, triggeredAt: Date) {
  pending = { shop: domain, session: (await prisma.session.findFirst({ where: { shop: domain } })) ?? null };
  const { action } = await import("../../app/routes/webhooks.app.uninstalled");
  await action({
    request: new Request("https://example.invalid/webhooks/app/uninstalled", {
      method: "POST",
      headers: { "x-shopify-triggered-at": triggeredAt.toISOString() },
    }),
  } as never);
}

const session = (domain: string) =>
  prisma.session.create({ data: { id: `offline_${domain}`, shop: domain, state: "", accessToken: "token" } });

describe("chaos: a merchant uninstalls", () => {
  it("is left alone by every background job, and comes back on reinstall", async () => {
    await withChaos("uninstall", { catalog: { products: 2, variantsPerProduct: 1 } }, async (chaos) => {
      const { shopId, domain, campaignId } = chaos.fixture;
      await session(domain);
      await writePreferences(shopId, { email: "merchant@example.com", weeklyDigest: true } as never);
      // A sale whose start has passed: due on the next tick.
      const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
      const startAt = new Date(Date.now() - 60_000);
      await prisma.campaign.update({
        where: { id: campaignId },
        data: { status: "SCHEDULED", startAt, schedule: { ...(campaign.schedule as object), kind: "window", startAt: startAt.toISOString() } as never },
      });

      await uninstall(domain, new Date());

      const shop = await prisma.shop.findUniqueOrThrow({ where: { id: shopId } });
      expect(shop.uninstalledAt, "the uninstall was never recorded").not.toBeNull();
      expect(await prisma.session.count({ where: { shop: domain } })).toBe(0);
      const entry = await prisma.auditLogEntry.findFirstOrThrow({ where: { shopId, action: "shop.uninstall" } });
      expect(entry.after).toMatchObject({ liveCampaigns: [] });

      // The weekly digest: no email to a merchant who left.
      await sendDueDigests(new Date());
      expect(await prisma.auditLogEntry.count({ where: { shopId, action: "notification.digest" } }), "a digest went to an uninstalled shop").toBe(0);

      // The scheduler: the due campaign is not attempted, so no session is asked for.
      asked.length = 0;
      await tick(new Date());
      expect(asked, "the scheduler attempted an uninstalled shop's campaign").not.toContain(domain);
      expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status).toBe("SCHEDULED");
      expect(await prisma.campaignRun.count({ where: { campaignId } })).toBe(0);

      // Flow triggers.
      asked.length = 0;
      await fireTriggerForShop(shopId, "campaign-started", { campaignId, campaignName: "x" } as never);
      expect(asked).not.toContain(domain);

      // Reinstall clears it...
      await ensureShop(domain);
      const back = await prisma.shop.findUniqueOrThrow({ where: { id: shopId } });
      expect(back.uninstalledAt).toBeNull();
      await sendDueDigests(new Date());
      expect(await prisma.auditLogEntry.count({ where: { shopId, action: "notification.digest" } }), "the control: a digest after reinstall").toBe(1);

      // ...and an uninstall Shopify triggered before the reinstall, delivered late, is not
      // allowed to mark the reinstalled shop gone or delete the session it is using.
      await session(domain);
      await uninstall(domain, new Date(back.installedAt.getTime() - 60_000));
      expect((await prisma.shop.findUniqueOrThrow({ where: { id: shopId } })).uninstalledAt, "a stale uninstall unmarked the reinstall").toBeNull();
      expect(await prisma.session.count({ where: { shop: domain } })).toBe(1);

      await prisma.session.deleteMany({ where: { shop: domain } });
    });
  });

  it("records the campaigns it left live", async () => {
    await withChaos("uninstall-live", { catalog: { products: 2, variantsPerProduct: 1 } }, async (chaos) => {
      const { shopId, domain, campaignId } = chaos.fixture;
      await chaos.expectHonest((await chaos.apply()).runId);

      await uninstall(domain, new Date());

      const entry = await prisma.auditLogEntry.findFirstOrThrow({ where: { shopId, action: "shop.uninstall" } });
      expect((entry.after as { liveCampaigns: Array<{ id: string; status: string }> }).liveCampaigns).toEqual([
        expect.objectContaining({ id: campaignId, status: "ACTIVE" }),
      ]);
    });
  });
});
