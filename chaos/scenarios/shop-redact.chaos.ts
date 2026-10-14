/**
 * `shop/redact` leaves nothing behind that names the shop (#785).
 *
 * The handler deleted the Shop row and its sessions and trusted the cascade for the rest.
 * `error_events` is the table it did not reach: SetNull, so a redacted shop's failures
 * survived detached, and the ones recorded before the shop was known never pointed at it
 * at all -- while their message, stack or context still named its domain. Deliveries
 * recorded without a shop kept the domain the same way, and the redact's own delivery
 * was recorded under it after the handler had finished erasing.
 *
 * Driven through the real route, so it is the handler's own reach under test. A second
 * shop whose domain *contains* the first one's stands next to it, because erasing by the
 * text of a domain is only right if it erases nobody else.
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { ERROR_EVENT_DAYS, pruneErrorEvents } from "../../app/services/error-report.server";
import { ERASED_SHOP } from "../../app/services/webhook-log.server";
import { withChaos } from "../harness/scenario";

let respond: () => Promise<unknown> = async () => ({});

vi.mock("../../app/shopify.server", () => ({
  authenticate: { webhook: async () => respond() },
}));

function redact(webhookId: string, shop: string) {
  return {
    request: new Request("https://example.invalid/webhooks/compliance", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Webhook-Id": webhookId,
        "X-Shopify-Topic": "shop/redact",
        "X-Shopify-Shop-Domain": shop,
      },
      body: JSON.stringify({ shop_domain: shop }),
    }),
    params: {},
    context: {},
  } as never;
}

function failure(errorId: string, fields: { shopId?: string | null; message?: string; stack?: string; context?: object }) {
  return prisma.errorEvent.create({
    data: {
      errorId,
      shopId: fields.shopId ?? null,
      code: "SHOPIFY_UNAVAILABLE",
      message: fields.message ?? "SHOPIFY_UNAVAILABLE: fetch failed",
      stack: fields.stack ?? null,
      userMessage: "Shopify did not answer. Nothing was changed.",
      context: (fields.context ?? null) as never,
    },
  });
}

/** Every row whose text contains `domain` anywhere, as a plain substring. */
async function mentioning(domain: string): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ errorId: string }>>`
    SELECT "errorId" FROM error_events
    WHERE strpos(lower(concat_ws(' ', message, stack, "userMessage", route, context::text)), lower(${domain})) > 0
  `;
  return rows.map((row) => row.errorId).sort();
}

describe("chaos: shop/redact", () => {
  it("erases the shop's failures, sessions and deliveries, and nobody else's", async () => {
    await withChaos("shop-redact", { catalog: { products: 1, variantsPerProduct: 1 }, percent: -10 }, async (chaos) => {
      const { domain, shopId } = chaos.fixture;
      // Contains `domain` as a substring, which is the whole point of it.
      const neighbourDomain = `my${domain}`;
      const run = `ANC-REDACT-${Date.now()}`;
      const webhookId = `redact-${Date.now()}`;

      await prisma.shop.deleteMany({ where: { domain: neighbourDomain } });
      const neighbour = await prisma.shop.create({ data: { domain: neighbourDomain } });

      try {
        // Its own failures: one attributed, and three recorded before it was known that
        // name it in the context, the message and the stack.
        await failure(`${run}-OWN`, { shopId });
        await failure(`${run}-CONTEXT`, { context: { url: `https://${domain}/admin/api/2025-07/graphql.json` } });
        await failure(`${run}-MESSAGE`, { message: `SHOPIFY_UNAVAILABLE: No usable session for ${domain}.` });
        await failure(`${run}-STACK`, { stack: `Error: fetch failed\n    at fetch (https://${domain.toUpperCase()}/admin)` });
        // Somebody else's, including one that names a domain containing this one.
        await failure(`${run}-NEIGHBOUR`, { shopId: neighbour.id, context: { shop: neighbourDomain } });
        await failure(`${run}-NEIGHBOUR-ORPHAN`, { message: `SHOPIFY_UNAVAILABLE: fetch https://${neighbourDomain}/admin failed` });
        await failure(`${run}-NOBODY`, { message: "SHOPIFY_UNAVAILABLE: fetch failed before any shop was known" });

        // Deliveries: one attributed, one recorded before the shop row existed, and the
        // neighbour's.
        await prisma.webhookEvent.createMany({
          data: [
            { webhookId: `${webhookId}-own`, shopId, shopDomain: domain, topic: "products/update", payload: {} },
            { webhookId: `${webhookId}-orphan`, shopId: null, shopDomain: domain, topic: "app/scopes_update", payload: {} },
            { webhookId: `${webhookId}-neighbour`, shopId: neighbour.id, shopDomain: neighbourDomain, topic: "products/update", payload: {} },
          ],
        });

        for (const shop of [domain, neighbourDomain]) {
          await prisma.session.upsert({
            where: { id: `offline_${shop}` },
            create: { id: `offline_${shop}`, shop, state: "", accessToken: "chaos-not-a-token" },
            update: {},
          });
        }

        const { action } = await import("../../app/routes/webhooks.compliance");
        respond = async () => ({ shop: domain, topic: "SHOP_REDACT", payload: { shop_domain: domain }, session: null });
        const response = await action(redact(webhookId, domain));
        expect(response.status, "shop/redact was not acknowledged").toBe(200);

        // Nothing in error_events names the shop. What still contains its domain as text
        // is the neighbour's, and only because the neighbour's domain contains it.
        expect(
          await mentioning(domain),
          "an error record still names the redacted shop",
        ).toEqual([`${run}-NEIGHBOUR`, `${run}-NEIGHBOUR-ORPHAN`].sort());
        expect(await prisma.errorEvent.count({ where: { errorId: `${run}-OWN` } }), "its attributed failure survived").toBe(0);
        expect(
          (await prisma.errorEvent.findMany({ where: { errorId: { startsWith: run } }, select: { errorId: true } }))
            .map((row) => row.errorId)
            .sort(),
          "the redact took somebody else's failures with it",
        ).toEqual([`${run}-NEIGHBOUR`, `${run}-NEIGHBOUR-ORPHAN`, `${run}-NOBODY`].sort());

        // Its deliveries are gone, attributed or not, and the redact's own is kept as nobody's.
        expect(await prisma.webhookEvent.count({ where: { shopDomain: domain } }), "a delivery still names it").toBe(0);
        expect(await prisma.webhookEvent.count({ where: { webhookId: `${webhookId}-neighbour` } })).toBe(1);
        expect(await prisma.webhookEvent.findUnique({ where: { webhookId } })).toMatchObject({
          shopId: null,
          shopDomain: ERASED_SHOP,
          topic: "shop/redact",
          status: "PROCESSED",
        });

        // The shop and its sessions, as before; the neighbour's untouched.
        expect(await prisma.shop.count({ where: { domain } })).toBe(0);
        expect(await prisma.shop.count({ where: { domain: neighbourDomain } })).toBe(1);
        expect(await prisma.session.count({ where: { shop: domain } })).toBe(0);
        expect(await prisma.session.count({ where: { shop: neighbourDomain } })).toBe(1);
      } finally {
        await prisma.errorEvent.deleteMany({ where: { errorId: { startsWith: run } } });
        await prisma.webhookEvent.deleteMany({ where: { webhookId: { startsWith: webhookId } } });
        await prisma.session.deleteMany({ where: { shop: { in: [domain, neighbourDomain] } } });
        await prisma.shop.deleteMany({ where: { domain: neighbourDomain } });
      }
    });
  });

  it("keeps ninety days of failures and prunes the rest", async () => {
    const now = new Date();
    const old = new Date(now.getTime() - (ERROR_EVENT_DAYS + 1) * 24 * 60 * 60_000);
    const run = `ANC-RETAIN-${Date.now()}`;
    await prisma.errorEvent.createMany({
      data: [
        { errorId: `${run}-OLD`, code: "UNKNOWN", message: "old", userMessage: "Something went wrong.", createdAt: old },
        { errorId: `${run}-NEW`, code: "UNKNOWN", message: "new", userMessage: "Something went wrong.", createdAt: now },
      ],
    });
    // Batched, so drain whatever else the shared database has past its keeping first.
    while ((await pruneErrorEvents(now)) > 0);
    expect(await prisma.errorEvent.count({ where: { errorId: `${run}-OLD` } }), "an old failure was kept").toBe(0);
    expect(await prisma.errorEvent.count({ where: { errorId: `${run}-NEW` } }), "a recent failure was pruned").toBe(1);
    await prisma.errorEvent.deleteMany({ where: { errorId: { startsWith: run } } });
  });
});
