/**
 * The bulk cost form, submitted on shops whose currency is not two-decimal (#694).
 *
 * The form turned the typed amount into minor units with a literal 100: "Set an exact
 * cost 1500" on a yen shop stored ¥150,000, and 1.5 on a dinar shop stored 0.150. Costs
 * set the never-below-cost floor, so the yen mistake put a ¥3,000 product at ¥150,000 on
 * the next run. The confirmation text divided by the same literal and so showed the number
 * the merchant typed, which is why nobody saw it.
 *
 * Driven through the route's own action, so what is tested is the form a merchant submits.
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { withChaos } from "../harness/scenario";

/** Who the next request authenticates as. Mutable, because the mock is bound once. */
let pendingShop = "";

// The one boundary that needs a real Shopify session. Everything past it -- the form,
// the currency, the rule, the ledger -- is the real code.
vi.mock("../../app/shopify.server", () => ({
  authenticate: {
    admin: async () => ({ session: { shop: pendingShop }, sessionToken: undefined }),
  },
}));

async function submit(shopDomain: string, fields: Record<string, string>) {
  pendingShop = shopDomain;
  const { action } = await import("../../app/routes/app.prices.costs");
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  const response = await action({
    request: new Request("https://example.invalid/app/prices/costs", { method: "POST", body }),
    params: {},
    context: {},
  } as never);
  return (response instanceof Response ? await response.json() : response) as {
    ok: boolean;
    message: string;
  };
}

describe("chaos: the bulk cost form", () => {
  it.each([
    { currency: "JPY", typed: "1500", minor: 1_500n, shown: "1500" },
    { currency: "KWD", typed: "1.5", minor: 1_500n, shown: "1.500" },
  ])("stores $typed $currency as $minor minor units and says so", async ({ currency, typed, minor, shown }) => {
    await withChaos(
      `cost-form-${currency.toLowerCase()}`,
      { catalog: { products: 2, variantsPerProduct: 1, currency }, percent: -10 },
      async (chaos) => {
        const { shopId, domain, variantGids } = chaos.fixture;
        const fields = { ruleKind: "set-exact", value: typed };

        // The dry run is what the merchant reads before committing. It must name the
        // amount that will be stored, not echo what was typed through a second mistake.
        const dry = await submit(domain, { ...fields, intent: "dry-run" });
        expect(dry.ok).toBe(true);
        expect(dry.message).toContain(`Set every matching cost to ${shown}:`);

        await submit(domain, { ...fields, intent: "commit" });

        for (const gid of variantGids) {
          const current = await prisma.baseline.findFirstOrThrow({
            where: { shopId, variantGid: gid, supersededAt: null, surfaceKind: "BASE" },
          });
          expect(current.cost, `${currency} cost stored in the wrong minor units`).toBe(minor);
          expect(current.currency).toBe(currency);
        }
      },
    );
  });
});
