/**
 * One shop failing while the platform looks healthy.
 *
 * `evaluate` is pure and unit-tested, so the part that can still be wrong is the query
 * that feeds it — which is exactly where the scheduler-heartbeat bug lived. A per-shop
 * rate needs two groupings that agree with each other: errors keyed by shop, and
 * deliveries keyed by shop, in the same window. Get the denominator from the wrong place
 * and the alert either never fires or fires constantly, and a unit test with a
 * hand-written window would agree with either.
 *
 * So this runs against real Postgres and writes real rows.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { gather } from "../../app/services/alerting.server";
import { evaluate, SHOP_SAMPLE_MINIMUM } from "../../app/lib/observability/alerts";
import { withChaos } from "../harness/scenario";

async function deliveries(shopId: string, shopDomain: string, count: number, at: Date) {
  for (let i = 0; i < count; i++) {
    await prisma.webhookEvent.create({
      data: {
        webhookId: `spike-${shopId}-${i}-${at.getTime()}`,
        shopId,
        shopDomain,
        topic: "products/update",
        payload: {},
        status: "PROCESSED",
        receivedAt: at,
        processedAt: at,
      },
    });
  }
}

async function failures(shopId: string, count: number, at: Date) {
  for (let i = 0; i < count; i++) {
    await prisma.errorEvent.create({
      data: {
        errorId: `ANC-SPIKE-${shopId}-${i}-${at.getTime()}`,
        shopId,
        code: "SHOPIFY_REJECTED",
        message: "Shopify refused the write",
        userMessage: "Shopify would not accept this price. Check the market's minimum.",
      },
    });
  }
}

/** Comfortably over `SHOP_SAMPLE_MINIMUM`, so this shop's own rate is meaningful. */
const FAILING_SHOP_DELIVERIES = 35;
/** 30/35 is catastrophic for this shop; 30/635 is a quiet afternoon for the platform. */
const FAILING_SHOP_ERRORS = 30;
/** Enough to push the platform's true delivery count well past the 500-row lag sample. */
const BUSY_SHOP_DELIVERIES = 600;

describe("chaos: one shop failing inside a healthy platform", () => {
  it("fires per-shop without firing the global rate", async () => {
    await withChaos(
      "shop-error-spike",
      { catalog: { products: 2, variantsPerProduct: 1 }, percent: -10 },
      async (chaos) => {
        // If somebody raises the minimum past these numbers the scenario stops testing
        // what it claims to, silently — the shop would be below the sample floor and the
        // alert would correctly not fire, which looks like a pass.
        expect(FAILING_SHOP_DELIVERIES).toBeGreaterThan(SHOP_SAMPLE_MINIMUM);

        const now = new Date();

        // Rows from earlier runs of this scenario live in the same database and land in
        // the same fifteen-minute window, so without this the global error count climbs
        // by 25 every run until the platform-is-healthy assertion below fails for a
        // reason that has nothing to do with the code.
        await prisma.errorEvent.deleteMany({ where: { errorId: { startsWith: "ANC-SPIKE-" } } });
        await prisma.webhookEvent.deleteMany({ where: { webhookId: { startsWith: "spike-" } } });
        await prisma.shop.deleteMany({ where: { domain: { startsWith: "busy-" } } });
        const shop = await prisma.shop.findUniqueOrThrow({
          where: { id: chaos.fixture.shopId },
          select: { id: true, domain: true },
        });

        // A second, much busier shop with nothing wrong with it. It exists so the global
        // denominator and this shop's differ — without it the two are identical and the
        // test cannot tell a per-shop rate from a global one. Mutation testing caught
        // exactly that: swapping the denominator for the global count passed happily.
        const other = await prisma.shop.create({
          data: { domain: `busy-${Date.now()}.myshopify.com` },
          select: { id: true, domain: true },
        });
        await deliveries(other.id, other.domain, BUSY_SHOP_DELIVERIES, now);

        // The failing shop is quiet by comparison: enough traffic for its rate to count,
        // nowhere near enough to move the platform's.
        //
        // The numbers are chosen so the two denominators disagree about whether the
        // *global* alert should fire. 30 failures against the true 635 deliveries is
        // 4.7% and stays quiet; against the capped 500-row sample it is 6% and pages.
        // Anything nearer the threshold passes under both and proves nothing.
        await deliveries(shop.id, shop.domain, FAILING_SHOP_DELIVERIES, now);

        const healthy = await gather(now);
        expect(evaluate(healthy).map((a) => a.id)).not.toContain("shop-error-spike");

        // Now this one shop starts failing. Its own rate is catastrophic; the global rate
        // is still nowhere near the 5% floor, which is the whole point of the alert.
        await failures(shop.id, FAILING_SHOP_ERRORS, now);

        const window = await gather(now);
        const mine = window.shopRates?.find((rate) => rate.shopId === shop.id);

        expect(mine, "the shop is missing from shopRates entirely").toBeDefined();
        expect(mine!.errors).toBe(FAILING_SHOP_ERRORS);
        // Exactly this shop's deliveries, not the platform's. The busy shop above has 600
        // of its own, so any denominator drawn from the global pool fails here.
        expect(
          mine!.requests,
          "the denominator did not come from this shop's own deliveries",
        ).toBe(FAILING_SHOP_DELIVERIES);

        expect(evaluate(window).map((a) => a.id)).toContain("shop-error-spike");
        expect(
          evaluate(window).map((a) => a.id),
          "the platform is healthy, so the global rate must stay quiet",
        ).not.toContain("error-spike");

        await prisma.errorEvent.deleteMany({ where: { errorId: { startsWith: "ANC-SPIKE-" } } });
        await prisma.webhookEvent.deleteMany({ where: { webhookId: { startsWith: "spike-" } } });
        // Including the shop itself. Leaving it behind put sixteen `busy-…` rows in the
        // database over an afternoon, and a `shop` table full of fixtures makes a real
        // question — "which stores are installed?" — harder to answer than it should be.
        // Earlier runs are cleaned too, so a database that already collected some
        // recovers on the next run rather than needing somebody to notice.
        await prisma.shop.deleteMany({ where: { domain: { startsWith: "busy-" } } });
      },
    );
  });
});
