/**
 * One shop's errors on another shop's Diagnostics page (#717).
 *
 * `withGuard` reported route errors with a domain from the query string and no shop id,
 * so nearly every error was stored unattributed. Diagnostics listed the shop's own rows
 * *and* every unattributed one, and looked a reference up with no shop at all -- so a
 * merchant who installed today could read other merchants' messages, context and stack
 * traces, by list or by quoting an id.
 *
 * Driven through real guarded routes: a campaign page that fails for each shop, then each
 * shop's Diagnostics loader. Only `authenticate.admin` is replaced, with the shop chosen
 * per request.
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { ANCHOR_ERROR } from "../../app/lib/errors/guard.server";
import { withChaos } from "../harness/scenario";

let signedIn = "";

vi.mock("../../app/shopify.server", () => ({
  authenticate: {
    admin: async () => ({ session: { shop: signedIn }, sessionToken: undefined, admin: {} }),
  },
}));

/** A campaign page that fails after the shop is known, as the merchant of `shop`. */
async function failFor(shop: string, query = ""): Promise<string> {
  signedIn = shop;
  const { loader } = await import("../../app/routes/app.campaigns.$id");
  try {
    await loader({
      request: new Request(`https://example.invalid/app/campaigns/no-such-campaign${query}`),
      params: { id: "no-such-campaign" },
      context: {},
    } as never);
  } catch (thrown) {
    const reported = (thrown as { data?: Record<string, { errorId?: string }> }).data?.[ANCHOR_ERROR];
    if (reported?.errorId) return reported.errorId;
    throw thrown;
  }
  throw new Error("the campaign page did not fail");
}

async function diagnostics(shop: string, id = "") {
  signedIn = shop;
  const { loader } = await import("../../app/routes/app.settings.diagnostics");
  return (await loader({
    request: new Request(`https://example.invalid/app/settings/diagnostics${id ? `?id=${id}` : ""}`),
    params: {},
    context: {},
  } as never)) as { match: { errorId: string } | null; recent: Array<{ errorId: string }> };
}

describe("chaos: Diagnostics shows a shop only its own errors", () => {
  it("attributes route errors to the signed-in shop, and neither shop sees the other's", async () => {
    await withChaos("diagnostics-tenancy", { catalog: { products: 1, variantsPerProduct: 1 } }, async (chaos) => {
      const a = { id: chaos.fixture.shopId, domain: chaos.fixture.domain };
      const bRow = await prisma.shop.create({ data: { domain: `diag-other-${chaos.seed}.myshopify.com` } });
      const b = { id: bRow.id, domain: bRow.domain };

      try {
        const errorOfA = await failFor(a.domain);
        // `?shop=` is whatever the request says. It must not move the error to that shop.
        const errorOfAPosingAsB = await failFor(a.domain, `?shop=${b.domain}`);
        const errorOfB = await failFor(b.domain);
        const orphan = await prisma.errorEvent.create({
          data: { errorId: `ANC-DIAG-${chaos.seed}`, shopId: null, code: "UNKNOWN", message: "before any shop", userMessage: "x" },
        });

        const stored = async (errorId: string) =>
          (await prisma.errorEvent.findUniqueOrThrow({ where: { errorId } })).shopId;
        expect(await stored(errorOfA), "a route error was stored without its shop").toBe(a.id);
        expect(await stored(errorOfAPosingAsB)).toBe(a.id);
        expect(await stored(errorOfB)).toBe(b.id);

        const pageA = await diagnostics(a.domain);
        const listedA = pageA.recent.map((row) => row.errorId);
        expect(listedA).toEqual(expect.arrayContaining([errorOfA, errorOfAPosingAsB]));
        expect(listedA, "shop A was shown shop B's error").not.toContain(errorOfB);
        expect(listedA, "shop A was shown an error that belongs to nobody").not.toContain(orphan.errorId);

        const pageB = await diagnostics(b.domain);
        expect(pageB.recent.map((row) => row.errorId)).toEqual([errorOfB]);

        // By reference: your own id is found, somebody else's is not.
        expect((await diagnostics(a.domain, errorOfA)).match?.errorId).toBe(errorOfA);
        expect((await diagnostics(a.domain, errorOfB)).match, "shop A read shop B's error by its id").toBeNull();
        expect((await diagnostics(b.domain, errorOfA)).match).toBeNull();
        expect((await diagnostics(a.domain, orphan.errorId)).match).toBeNull();
      } finally {
        await prisma.errorEvent.deleteMany({ where: { OR: [{ shopId: b.id }, { errorId: `ANC-DIAG-${chaos.seed}` }] } });
        await prisma.shop.delete({ where: { id: b.id } });
      }
    });
  });
});
