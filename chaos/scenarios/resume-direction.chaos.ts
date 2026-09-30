/**
 * Resume after a partial revert (#702).
 *
 * A revert that ends PARTIAL leaves the campaign PARTIAL, and the page's primary button is
 * Resume. The route ran every Resume as an *apply*, and the apply's resume filter read the
 * ledger of the last apply run -- every row VERIFIED, from before the revert undid them --
 * so it wrote nothing, reported "already correct", and moved the campaign to ACTIVE with
 * "every row was read back and verified". The storefront was mostly back at full price,
 * and the merchant had pressed the button to finish ending the sale.
 *
 * Driven through the campaign page's own action; only `authenticate.admin` is replaced,
 * with an admin that talks to the fake store.
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { isVariantWrite } from "../harness/faults";
import { withChaos } from "../harness/scenario";

let pending = { shop: "", endpoint: "" };

vi.mock("../../app/shopify.server", () => ({
  authenticate: {
    admin: async () => ({
      session: { shop: pending.shop },
      sessionToken: undefined,
      admin: {
        async graphql(query: string, options?: { variables?: Record<string, unknown> }) {
          const response = await fetch(pending.endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query, variables: options?.variables ?? {} }),
          });
          return { json: () => response.json() };
        },
      },
    }),
  },
}));

async function press(intent: string, campaignId: string) {
  const { action } = await import("../../app/routes/app.campaigns.$id");
  const body = new FormData();
  body.set("intent", intent);
  const response = await action({
    request: new Request(`https://example.invalid/app/campaigns/${campaignId}`, { method: "POST", body }),
    params: { id: campaignId },
    context: {},
  } as never);
  return (response instanceof Response ? await response.json() : response) as { ok: boolean; message: string };
}

describe("chaos: Resume after a partial revert", () => {
  it("finishes the revert, and ends COMPLETED with every row at baseline", async () => {
    await withChaos(
      "resume-direction",
      { catalog: { products: 4, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const { domain, campaignId, variantGids, productOf, baseline } = chaos.fixture;
        pending = { shop: domain, endpoint: chaos.server.endpoint() };

        const applied = await chaos.apply();
        await chaos.expectHonest(applied.runId);

        // The revert reaches three products and fails on the fourth.
        const stuck = productOf.get(variantGids[0])!;
        chaos.arm([
          {
            fault: "server-error",
            match: (query, variables) => isVariantWrite(query) && variables.productId === stuck,
          },
        ]);
        await press("revert", campaignId);
        const afterRevert = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
        expect(afterRevert.status).toBe("PARTIAL");
        expect(chaos.fake.priceOf(variantGids[0]), "the failed row is still on sale").not.toBe(
          (baseline.get(variantGids[0])! / 100).toFixed(2),
        );

        // The failure clears, and the merchant presses the page's primary button.
        chaos.heal();
        await press("resume", campaignId);

        const after = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
        expect(after.status, "Resume re-applied the sale and called it live").toBe("COMPLETED");
        for (const gid of variantGids) {
          expect(chaos.fake.priceOf(gid)).toBe((baseline.get(gid)! / 100).toFixed(2));
        }
      },
    );
  });

  it("an apply resumed after a revert plans every row again instead of trusting the old apply's ledger", async () => {
    await withChaos(
      "resume-direction-ledger",
      { catalog: { products: 4, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const { variantGids, productOf, baseline } = chaos.fixture;

        await chaos.apply();
        chaos.arm([
          {
            fault: "server-error",
            match: (query, variables) =>
              isVariantWrite(query) && variables.productId === productOf.get(variantGids[0]),
          },
        ]);
        await chaos.revert();
        chaos.heal();

        // Any caller asking to resume an apply now. The last whole run was the revert, so
        // the old apply's VERIFIED rows say nothing about what is live: they were undone.
        const resumed = await chaos.apply({ resume: true });

        // Every row written and read back: none dropped as "already verified" on the
        // word of a ledger the revert had undone.
        expect(resumed.verified, "rows dropped as 'already verified' by a ledger the revert undid").toBe(
          variantGids.length,
        );
        for (const gid of variantGids) {
          expect(chaos.fake.priceOf(gid)).toBe((Math.round(baseline.get(gid)! * 0.8) / 100).toFixed(2));
        }
      },
    );
  });
});
