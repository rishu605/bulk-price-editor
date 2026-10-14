/**
 * Every webhook delivery is recorded, once per delivery, and only once it is verified (#712).
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { withChaos } from "../harness/scenario";

let respond: () => Promise<unknown> = async () => ({});

vi.mock("../../app/shopify.server", () => ({
  authenticate: { webhook: async () => respond() },
}));

function delivery(id: string, shop: string) {
  return {
    request: new Request("https://example.invalid/webhooks/app/scopes_update", {
      method: "POST",
      headers: { "X-Shopify-Webhook-Id": id, "X-Shopify-Topic": "app/scopes_update", "X-Shopify-Shop-Domain": shop },
    }),
    params: {},
    context: {},
  } as never;
}

describe("chaos: recording webhook deliveries", () => {
  it("records a verified delivery once, counts a retry, and ignores one it could not verify", async () => {
    await withChaos("webhook-log", { catalog: { products: 1, variantsPerProduct: 1 }, percent: -10 }, async (chaos) => {
      const { domain, shopId } = chaos.fixture;
      const { action } = await import("../../app/routes/webhooks.app.scopes_update");
      const id = `log-${Date.now()}`;

      respond = async () => ({ shop: domain, topic: "APP_SCOPES_UPDATE", payload: { current: [] }, session: null });
      await action(delivery(id, domain));
      await action(delivery(id, domain));
      const row = await prisma.webhookEvent.findUniqueOrThrow({ where: { webhookId: id } });
      expect(row).toMatchObject({ shopId, shopDomain: domain, topic: "app/scopes_update", status: "PROCESSED", attempts: 2 });
      expect(row.processedAt!.getTime()).toBeGreaterThanOrEqual(row.receivedAt.getTime());

      // Refused as unauthenticated: not a delivery, nothing recorded.
      respond = async () => {
        throw new Response(undefined, { status: 401 });
      };
      await action(delivery(`${id}-forged`, domain)).catch(() => undefined);
      expect(await prisma.webhookEvent.count({ where: { webhookId: `${id}-forged` } })).toBe(0);

      // Verified, then failed while being handled: recorded as failed, with why.
      respond = async () => ({ shop: domain, topic: "APP_SCOPES_UPDATE", payload: { current: [] }, session: { id: "no-such-session" } });
      await action(delivery(`${id}-failed`, domain)).catch(() => undefined);
      const failed = await prisma.webhookEvent.findUniqueOrThrow({ where: { webhookId: `${id}-failed` } });
      expect(failed.status).toBe("FAILED");
      expect(failed.failureReason).toMatch(/\S/);

      await prisma.webhookEvent.deleteMany({ where: { webhookId: { startsWith: id } } });
    });
  });

  it("keeps a week of deliveries and prunes the rest", async () => {
    const { pruneWebhookLog, WEBHOOK_LOG_DAYS } = await import("../../app/services/webhook-log.server");
    const now = new Date();
    const old = new Date(now.getTime() - (WEBHOOK_LOG_DAYS + 1) * 24 * 60 * 60_000);
    const id = `prune-${Date.now()}`;
    for (const [suffix, at] of [["old", old], ["new", now]] as const) {
      await prisma.webhookEvent.create({
        data: { webhookId: `${id}-${suffix}`, shopDomain: "prune.myshopify.com", topic: "products/update", payload: {}, status: "PROCESSED", receivedAt: at, processedAt: at },
      });
    }
    await pruneWebhookLog(now);
    expect(await prisma.webhookEvent.count({ where: { webhookId: `${id}-old` } }), "an old delivery was kept").toBe(0);
    expect(await prisma.webhookEvent.count({ where: { webhookId: `${id}-new` } }), "a recent delivery was pruned").toBe(1);
    await prisma.webhookEvent.deleteMany({ where: { webhookId: { startsWith: id } } });
  });
});
