/**
 * One drift email per campaign per hour, however many webhooks arrive at once (#806).
 *
 * The limit was check-then-act: count this hour's notifications, send if there were none,
 * then write the entry that the next count would see. A bulk edit in Shopify's admin fires
 * one products/update webhook per product, together, and every handler counted before the
 * first had written. On anchor-perf a burst of about 1,100 drift events logged 219 "a
 * campaign is held" notifications for one campaign inside a minute; a shop with an alert
 * address would have received all 219.
 *
 * Every edit arrives through the products webhook, all of them at once, as a bulk edit's
 * do. Only `authenticate.webhook` and the mail provider are replaced. The second campaign
 * is written as its ledger would show it having run: the newest landed row for a variant
 * is what makes a campaign its controller, and how it got there is not what this tests.
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import type { Notification } from "../../app/lib/notifications/templates";
import { withChaos, type ChaosContext } from "../harness/scenario";

const sent: Array<{ shopId: string; notification: Notification }> = [];

vi.mock("../../app/services/notifications.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../app/services/notifications.server")>()),
  notify: async (shopId: string, notification: Notification) => {
    sent.push({ shopId, notification });
    return { sent: true };
  },
}));

/** Each request's delivery, so concurrent webhooks cannot read one another's payload. */
const deliveries = new WeakMap<Request, { shop: string; topic: string; payload: unknown; admin: unknown }>();

vi.mock("../../app/shopify.server", () => ({
  authenticate: { webhook: async (request: Request) => deliveries.get(request)! },
}));

// No worker queue, so the route handles each delivery in the request -- its fallback, and
// the same `processProductsWebhook` the worker drains with (#811). REDIS_URL is set in CI's
// chaos job, so without this the route would hand the delivery to a queue nothing here
// consumes. The queued path itself is `webhook-queue.chaos.ts`'s.
vi.mock("../../app/worker/web-queue.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../app/worker/web-queue.server")>()),
  webQueue: () => null,
}));

const admin = {
  async graphql(_query: string, options?: { variables?: Record<string, unknown> }) {
    return { json: async () => ({ data: { product: { id: options?.variables?.id, isGiftCard: false } } }) };
  },
};

/** Fifty webhooks for the campaign under test, as the issue's acceptance asks; ten for another. */
const BURST = 50;
const OTHERS = 10;

let clock = 60_000;

/**
 * A bulk edit in the Shopify admin: every price changes, then every webhook lands at once.
 * Prices in odd cents, so none of them can be the echo of a price Anchor wrote.
 */
async function bulkEdit(chaos: ChaosContext, variantGids: readonly string[], dollars: number) {
  const { domain, productOf } = chaos.fixture;
  clock += 60_000;
  const updatedAt = new Date(Date.now() + clock).toISOString();
  const { action } = await import("../../app/routes/webhooks.products");

  const responses = await Promise.all(
    variantGids.map((variantGid, index) => {
      const price = `${dollars}.${String(11 + index).padStart(2, "0")}`;
      chaos.fake.variants.get(variantGid)!.price = price;
      const request = new Request("https://example.invalid/webhooks/products", { method: "POST" });
      deliveries.set(request, {
        shop: domain,
        topic: "PRODUCTS_UPDATE",
        admin,
        payload: {
          admin_graphql_api_id: productOf.get(variantGid)!,
          title: "Bulk-edited product",
          status: "active",
          tags: "chaos",
          updated_at: updatedAt,
          variants: [{ admin_graphql_api_id: variantGid, title: "V", price, compare_at_price: null }],
          variant_gids: [{ admin_graphql_api_id: variantGid }],
        },
      });
      return action({ request } as never);
    }),
  );
  expect(responses.every((response) => response.ok), "a products webhook in the burst failed").toBe(true);
}

/** Another campaign on the same shop, now the one that last priced these variants. */
async function campaignOver(shopId: string, variantGids: readonly string[]): Promise<string> {
  const campaign = await prisma.campaign.create({ data: { shopId, name: "chaos/other-sale", status: "ACTIVE" } });
  const run = await prisma.campaignRun.create({
    data: {
      shopId,
      campaignId: campaign.id,
      kind: "APPLY",
      status: "COMPLETED",
      occurrenceKey: "chaos-other-sale",
      startedAt: new Date(),
      finishedAt: new Date(),
    },
  });
  const live = await prisma.priceSurfaceEntry.findMany({
    where: { shopId, variantGid: { in: [...variantGids] }, surfaceKind: "BASE", priceListGid: "" },
    select: { variantGid: true, livePrice: true },
  });
  await prisma.variantChange.createMany({
    data: live.map(({ variantGid, livePrice }) => ({
      runId: run.id,
      shopId,
      variantGid,
      surfaceKind: "BASE" as const,
      currency: "USD",
      intendedPrice: livePrice,
      appliedPrice: livePrice,
      verifiedPrice: livePrice,
      status: "VERIFIED" as const,
      verifiedAt: new Date(),
    })),
  });
  return campaign.id;
}

describe("chaos: a bulk edit's webhooks for one campaign, all at once", () => {
  it("emails once per campaign, logs one notification, and emails again only after the hour", async () => {
    await withChaos("drift-email-burst", { catalog: { products: BURST + OTHERS, variantsPerProduct: 1 }, percent: -20 }, async (chaos) => {
      const { shopId, campaignId, variantGids } = chaos.fixture;
      const ours = variantGids.slice(0, BURST);
      const theirs = variantGids.slice(BURST);

      await chaos.expectHonest((await chaos.apply()).runId);
      const other = await campaignOver(shopId, theirs);
      sent.length = 0;

      const emailsFor = (id: string) =>
        sent.filter(({ notification }) => notification.kind === "drift-hold" && notification.campaignId === id);
      const logged = (id: string) => prisma.auditLogEntry.count({ where: { shopId, action: "notification.drift", entityId: id } });
      const status = async (id: string) => (await prisma.campaign.findUniqueOrThrow({ where: { id } })).status;
      // The merchant answers every question and the hold lifts, so the next edit is drift again.
      const answerAndRelease = async (id: string) => {
        await prisma.driftEvent.updateMany({ where: { shopId, campaignId: id, resolution: "PENDING" }, data: { resolution: "IGNORED" } });
        await prisma.campaign.update({ where: { id }, data: { status: "ACTIVE" } });
      };

      // Both campaigns' webhooks in one burst: the limit is per campaign, not per shop.
      await bulkEdit(chaos, [...ours, ...theirs], 1);

      // Every edit was recorded and both campaigns held: the limit drops emails, not drift.
      expect(await prisma.driftEvent.count({ where: { shopId, campaignId, resolution: "PENDING" } })).toBe(BURST);
      expect(await prisma.driftEvent.count({ where: { shopId, campaignId: other, resolution: "PENDING" } })).toBe(OTHERS);
      expect(await status(campaignId)).toBe("HELD");
      expect(await status(other)).toBe("HELD");

      expect(emailsFor(campaignId), `${BURST} webhooks at once sent more than one drift email`).toHaveLength(1);
      expect(await logged(campaignId), "the activity log records a notification per webhook").toBe(1);
      expect(emailsFor(other), "the other campaign's burst was swallowed by the first one's limit").toHaveLength(1);
      expect(await logged(other)).toBe(1);
      expect(emailsFor(campaignId)[0].notification).toMatchObject({ driftedCount: expect.any(Number) });

      // Released inside the hour and edited again at once: still the one email.
      await answerAndRelease(campaignId);
      await bulkEdit(chaos, ours, 2);
      expect(await status(campaignId)).toBe("HELD");
      expect(emailsFor(campaignId), "a second burst inside the hour sent another email").toHaveLength(1);
      expect(await logged(campaignId)).toBe(1);

      // More than an hour on: one more, and only one, however many arrive together.
      await prisma.auditLogEntry.updateMany({
        where: { shopId, action: "notification.drift", entityId: campaignId },
        data: { createdAt: new Date(Date.now() - 2 * 3_600_000) },
      });
      await answerAndRelease(campaignId);
      await bulkEdit(chaos, ours, 3);
      expect(emailsFor(campaignId), "a burst after the hour did not send exactly one more email").toHaveLength(2);
      expect(await logged(campaignId)).toBe(2);
      expect(emailsFor(other), "the other campaign was emailed again").toHaveLength(1);
    });
  });
});
