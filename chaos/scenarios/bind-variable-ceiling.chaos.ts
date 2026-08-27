/**
 * A campaign larger than Postgres will accept in one statement.
 *
 * `loadCandidates` asked for a campaign's baselines with one `variantGid IN (...)`
 * per query. Postgres allows 32,767 bind variables in a prepared statement, so a
 * campaign scoped to more variants than that could not be planned at all — it died
 * with `P2035` before a single price was written, and the merchant saw a raw Prisma
 * assertion rather than anything from the error taxonomy.
 *
 * It hid because Prisma chunks long `IN` lists on its own. It chunks at exactly
 * 32,767 elements and then adds the query's other binds on top, so the ceiling is
 * breached by however many other columns the where clause filters on — two, here.
 * That is why nothing under 32,767 variants ever showed it, and why every scale test
 * up to that point had passed.
 *
 * This runs against real Postgres because that is the only thing that enforces the
 * limit: a fake, a mock or a unit test would accept any list length and agree that
 * the code works.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { IN_CHUNK } from "../../app/lib/db/chunk";
import {
  loadCandidates,
  productMapFor,
  titleMapFor,
} from "../../app/services/campaigns/candidates.server";
import { captureBaselines } from "../../app/services/baselines.server";
import { withChaos } from "../harness/scenario";

/** Comfortably past the ceiling, and past a whole number of chunks. */
const OVER_CEILING = 34_000;

const TYPE = "Ceiling";

/** Bulk-inserted directly: this scenario is about statement size, not about syncing. */
async function seedWide(shopId: string, count: number): Promise<string[]> {
  const gids = Array.from({ length: count }, (_, i) => `gid://shopify/ProductVariant/9${i}`);

  for (let i = 0; i < count; i += 5_000) {
    const slice = gids.slice(i, i + 5_000);

    await prisma.variantIndex.createMany({
      data: slice.map((variantGid, n) => ({
        shopId,
        variantGid,
        productGid: `gid://shopify/Product/9${i + n}`,
        title: `Wide ${i + n}`,
        price: BigInt(10_000 + n),
        currency: "USD",
        productType: TYPE,
      })),
      skipDuplicates: true,
    });

    await prisma.priceSurfaceEntry.createMany({
      data: slice.map((variantGid, n) => ({
        shopId,
        variantGid,
        surfaceKind: "BASE" as const,
        priceListGid: "",
        currency: "USD",
        livePrice: BigInt(10_000 + n),
      })),
      skipDuplicates: true,
    });
  }

  return gids;
}

describe("chaos: a campaign wider than one prepared statement", () => {
  it("plans a scope past the bind-variable ceiling", async () => {
    await withChaos(
      "bind-variable-ceiling",
      { catalog: { products: 1, variantsPerProduct: 1 }, percent: -15 },
      async (ctx) => {
        expect(
          OVER_CEILING,
          "the scope must exceed what one statement can bind, or this proves nothing",
        ).toBeGreaterThan(32_767);

        const gids = await seedWide(ctx.fixture.shopId, OVER_CEILING);

        // Capture takes the same oversized list, and had the same ceiling.
        const capture = await captureBaselines(ctx.fixture.shopId, {
          variantGids: gids,
          source: "INSTALL_CAPTURE",
        });
        expect(capture.captured).toBe(OVER_CEILING);

        // The planner's own load: baselines and mirrored live values for the scope.
        const candidates = await loadCandidates(ctx.fixture.shopId, {
          groups: [{ conditions: [{ field: "productType", value: TYPE }] }],
        });
        expect(
          candidates.length,
          "every variant in scope must be planned, not the first chunk of them",
        ).toBe(OVER_CEILING);

        // Nothing may be lost or duplicated at a chunk seam.
        expect(new Set(candidates.map((c) => c.ref.variantGid)).size).toBe(OVER_CEILING);

        // A baseline that lands in a later chunk must be the one used for that variant,
        // not one smeared from the first batch.
        const last = candidates.find((c) => c.ref.variantGid === gids[OVER_CEILING - 1]);
        expect(last?.baseline.price.amount).toBe(10_000 + ((OVER_CEILING - 1) % 5_000));

        // The lookups the ledger and the rollback report use take the same list.
        const [titles, products] = await Promise.all([
          titleMapFor(ctx.fixture.shopId, gids),
          productMapFor(ctx.fixture.shopId, gids),
        ]);
        expect(titles.size).toBe(OVER_CEILING);
        expect(products.size).toBe(OVER_CEILING);
        expect(titles.get(gids[OVER_CEILING - 1])).toBe(`Wide ${OVER_CEILING - 1}`);
      },
    );
  });

  it("chunks below the ceiling with room for other filters", () => {
    // The queries above filter on shopId and surfaceKind as well as the gid list, and
    // the next one to gain a filter must not silently reintroduce the bug.
    expect(IN_CHUNK + 1_000).toBeLessThan(32_767);
  });
});
