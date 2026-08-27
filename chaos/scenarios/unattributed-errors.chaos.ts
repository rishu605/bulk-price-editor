/**
 * Errors the app could not attribute to a shop.
 *
 * A failure before `ensureShop` — a bad session, a route that threw while resolving the
 * shop, a bug in the unauthenticated path — records an error with no `shopId`. The
 * queries feeding the alerts treat those two ways on purpose: the global count includes
 * them, and the per-shop grouping filters them out with `shopId: { not: null }`.
 *
 * That is almost certainly right. Nobody's shop is failing, so no shop should be paged
 * about it; but something *is* failing, so the platform rate should say so.
 *
 * Nothing stated it and nothing tested it, and the cost of that was real: three
 * unattributed errors, recorded while the campaign page was throwing #346, inverted
 * `shop-error-spike`'s premise and it failed claiming the platform was unhealthy. The
 * behaviour was fine. The absence of an assertion about it was not.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { gather } from "../../app/services/alerting.server";
import { withChaos } from "../harness/scenario";

const PREFIX = "ANC-ORPHAN-";

async function unattributedFailures(count: number) {
  for (let i = 0; i < count; i++) {
    await prisma.errorEvent.create({
      data: {
        errorId: `${PREFIX}${i}-${Date.now()}`,
        // No shop. This is the whole point.
        shopId: null,
        code: "UNKNOWN",
        message: "Threw before the shop was known",
        userMessage: "Something went wrong.",
      },
    });
  }
}

describe("chaos: an error with no shop", () => {
  it("counts against the platform and against nobody's shop", async () => {
    await withChaos(
      "unattributed-errors",
      { catalog: { products: 1, variantsPerProduct: 1 }, percent: -10 },
      async (chaos) => {
        await prisma.errorEvent.deleteMany({ where: { errorId: { startsWith: PREFIX } } });

        const now = new Date();
        const before = await gather(now);
        const beforeMine = before.shopRates?.find(
          (rate) => rate.shopId === chaos.fixture.shopId,
        );

        await unattributedFailures(6);

        const after = await gather(now);

        expect(
          after.errors - before.errors,
          "the platform rate must see a failure nobody can be paged for",
        ).toBe(6);

        const afterMine = after.shopRates?.find((rate) => rate.shopId === chaos.fixture.shopId);
        expect(
          (afterMine?.errors ?? 0) - (beforeMine?.errors ?? 0),
          "no shop's own rate may move for an error that was not theirs",
        ).toBe(0);

        // And they belong to no shop at all, rather than being quietly assigned to one.
        expect(
          after.shopRates?.some((rate) => rate.shopId === null),
          "an unattributed error must not appear as a shop with a null id",
        ).toBeFalsy();
      },
    );
  });

  it("does not survive its own scenario, so the next one starts clean", async () => {
    // The teardown clears these precisely because nothing else can: they have no shop to
    // cascade from. Three left behind is enough to break `shop-error-spike`.
    await withChaos(
      "unattributed-cleanup",
      { catalog: { products: 1, variantsPerProduct: 1 }, percent: -10 },
      async () => {
        await unattributedFailures(3);
        expect(await prisma.errorEvent.count({ where: { shopId: null } })).toBeGreaterThan(0);
      },
    );

    expect(
      await prisma.errorEvent.count({ where: { shopId: null } }),
      "unattributed errors outlived the fixture, and the next scenario inherits them",
    ).toBe(0);
  });
});
