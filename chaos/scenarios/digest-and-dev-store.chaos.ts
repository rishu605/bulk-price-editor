/**
 * The first weekly digest waits a week, and a development store transferred to a merchant
 * stops being free (#713).
 *
 * - The digest took "a week ago" as the start for a shop that had never had one, so the
 *   first went out on the very next tick: a digest of the day it was turned on.
 * - Only a full sync set `developerStore`, which gives every tier free. A store an agency
 *   built and synced, then transferred, stayed free for good: webhooks keep the mirror
 *   current, so nobody presses Sync.
 *
 * Through the real `sendDueDigests`, `writePreferences`, and the scheduler's `tick` at an
 * off-peak hour, with the fake answering the shop's plan.
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { billingFrom } from "../../app/services/billing.server";
import { sendDueDigests } from "../../app/services/digest.server";
import { writePreferences } from "../../app/services/notifications.server";
import { refreshDeveloperStore } from "../../app/services/sync-job.server";
import { tick } from "../../app/services/scheduler.server";
import { chaosAdminClient } from "../harness/http-client";
import { fixtureAdminClient, withChaos } from "../harness/scenario";

let endpoint = "";
vi.mock("../../app/services/admin-client.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/services/admin-client.server")>();
  return { ...actual, adminClientForShop: async (domain: string) => fixtureAdminClient(domain, endpoint) };
});
vi.mock("../../app/services/notifications.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../app/services/notifications.server")>()),
  notify: async () => ({ sent: true }),
}));

const DAY = 24 * 60 * 60_000;
const digests = (shopId: string) => prisma.auditLogEntry.count({ where: { shopId, action: "notification.digest" } });

describe("chaos: a shop's weekly digest and its development-store flag", () => {
  it("sends the first digest a week after it is turned on, not on the next tick", async () => {
    await withChaos("digest-first-week", { catalog: { products: 1, variantsPerProduct: 1 } }, async (chaos) => {
      const { shopId } = chaos.fixture;
      await writePreferences(shopId, { email: "merchant@example.com", weeklyDigest: true } as never);

      await sendDueDigests(new Date());
      expect(await digests(shopId), "the first digest went out the moment it was turned on").toBe(0);
      await sendDueDigests(new Date(Date.now() + 6 * DAY));
      expect(await digests(shopId)).toBe(0);
      await sendDueDigests(new Date(Date.now() + 7 * DAY + 60_000));
      expect(await digests(shopId)).toBe(1);

      // Off and on again: a new week from then.
      await writePreferences(shopId, { email: "merchant@example.com", weeklyDigest: false } as never);
      await writePreferences(shopId, { email: "merchant@example.com", weeklyDigest: true } as never);
      const settings = (await prisma.shop.findUniqueOrThrow({ where: { id: shopId } })).settings as Record<string, unknown>;
      expect(typeof settings.digestEnabledAt).toBe("string");
    });
  });

  it("ends a transferred development store's free tier at the daily check, and keeps it when the check fails", async () => {
    await withChaos("dev-store-transferred", { catalog: { products: 1, variantsPerProduct: 1 } }, async (chaos) => {
      const { shopId } = chaos.fixture;
      endpoint = chaos.server.endpoint();
      await prisma.shop.update({ where: { id: shopId }, data: { developerStore: true, initialSyncCompletedAt: new Date(), timezone: "UTC" } });
      expect(billingFrom(await prisma.shop.findUniqueOrThrow({ where: { id: shopId } })).exempt).toBe(true);

      // A failed read is not a transfer.
      chaos.fake.partnerDevelopment = null;
      expect(await refreshDeveloperStore(chaosAdminClient(endpoint), shopId)).toBe(true);
      expect((await prisma.shop.findUniqueOrThrow({ where: { id: shopId } })).developerStore).toBe(true);

      // Transferred: Shopify says it is no longer a development store. The scheduler's daily
      // check, at 3am in the shop's zone, ends the exemption and says so.
      chaos.fake.partnerDevelopment = false;
      const threeAm = new Date();
      threeAm.setUTCHours(3, 0, 0, 0);
      await tick(threeAm);
      const shop = await prisma.shop.findUniqueOrThrow({ where: { id: shopId } });
      expect(shop.developerStore, "a transferred development store stayed free").toBe(false);
      expect(billingFrom(shop).exempt).toBe(false);
      const entry = await prisma.auditLogEntry.findFirstOrThrow({ where: { shopId, action: "shop.developer-store" } });
      expect(entry.after).toEqual({ developerStore: false });
    });
  });
});
