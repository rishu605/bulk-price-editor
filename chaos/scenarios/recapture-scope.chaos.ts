/**
 * Recapture rewrites the scope the merchant chose, and only that (#716).
 *
 * The page's scope picker was a GET *fetcher*: it loaded into `fetcher.data`, which
 * nothing read, so the count, the overlaps and the scope posted with Recapture stayed the
 * whole catalogue. A merchant who picked one segment and pressed Replace re-baselined
 * every variant in the store. The picker now navigates, and the page posts the count it
 * showed, which the service checks against the scope it is about to rewrite.
 *
 * Driven through the page's own loader and action; only `authenticate.admin` is replaced.
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { withChaos } from "../harness/scenario";

let pending = { shop: "" };

vi.mock("../../app/shopify.server", () => ({
  authenticate: {
    admin: async () => ({ session: { shop: pending.shop }, sessionToken: undefined, admin: {} }),
  },
}));

const PAGE = "https://example.invalid/app/prices/baselines/recapture";

async function load(query: string) {
  const { loader } = await import("../../app/routes/app.prices.baselines.recapture");
  return (await loader({ request: new Request(`${PAGE}${query}`), params: {}, context: {} } as never)) as {
    assessment: { scope: number };
    segmentId: string;
  };
}

async function post(fields: Record<string, string>) {
  const { action } = await import("../../app/routes/app.prices.baselines.recapture");
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return (await action({
    request: new Request(PAGE, { method: "POST", body }),
    params: {},
    context: {},
  } as never)) as { ok: boolean; message: string };
}

describe("chaos: recapturing a chosen scope", () => {
  it("rewrites only the chosen segment, and refuses a count the page did not show", async () => {
    await withChaos("recapture-scope", { catalog: { products: 4, variantsPerProduct: 1 } }, async (chaos) => {
      const { shopId, domain, variantGids, baseline } = chaos.fixture;
      pending = { shop: domain };

      // Every price has genuinely gone up by a pound -- the reason to recapture at all.
      for (const gid of variantGids) {
        await prisma.priceSurfaceEntry.updateMany({
          where: { shopId, variantGid: gid },
          data: { livePrice: BigInt(baseline.get(gid)! + 100) },
        });
      }
      const { createSegment } = await import("../../app/services/segments-crud.server");
      const chosen = await createSegment(shopId, {
        name: `recapture-scope-${chaos.seed}`,
        kind: "FROZEN",
        variantGids: [variantGids[0]],
      });

      // Choosing the segment is a navigation, so the loader describes it.
      const page = await load(`?segment=${chosen.id}`);
      expect(page.segmentId).toBe(chosen.id);
      expect(page.assessment.scope, "the page counted the whole catalogue").toBe(1);

      // A count the page did not show is refused, and so is a request with none.
      const stale = await post({ segment: chosen.id, scope: String(variantGids.length) });
      expect(stale.ok).toBe(false);
      expect(stale.message).toMatch(/1 variant now, not the 4 you were shown/);
      expect((await post({ segment: chosen.id })).ok).toBe(false);
      expect(await prisma.baseline.count({ where: { shopId, source: "RECAPTURE" } })).toBe(0);

      // What the page posts after that navigation: the chosen segment and its count.
      const done = await post({ segment: page.segmentId, scope: String(page.assessment.scope) });
      expect(done.ok, done.message).toBe(true);

      const current = async (gid: string) =>
        Number(
          (await prisma.baseline.findFirstOrThrow({ where: { shopId, variantGid: gid, supersededAt: null } }))
            .basePrice,
        );
      expect(await current(variantGids[0])).toBe(baseline.get(variantGids[0])! + 100);
      for (const gid of variantGids.slice(1)) {
        expect(await current(gid), "a variant outside the chosen segment was re-baselined").toBe(baseline.get(gid));
      }
    });
  });
});
