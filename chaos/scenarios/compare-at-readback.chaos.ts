/**
 * A compare-at Shopify did not store is not verified (#988).
 *
 * Read-back compared the price only. The same mutation writes the strike-through, and a
 * compare-at Shopify dropped or altered -- with no error -- left a clean run over a
 * storefront showing no saving, or the wrong one.
 *
 * Through the real apply, on both write paths, with the fake storing a different
 * compare-at for one variant than it was sent.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { ledgerOf, withChaos } from "../harness/scenario";

describe("chaos: a compare-at Shopify did not store", () => {
  it.each(["sync", "bulk"] as const)("fails that row and leaves the run partial, on the %s path", async (path) => {
    await withChaos(`compare-at-readback-${path}`, { catalog: { products: 3, variantsPerProduct: 1 }, percent: -20 }, async (chaos) => {
      const { campaignId, variantGids } = chaos.fixture;
      const [dropped] = variantGids;
      // The sale strikes through its baseline price.
      await prisma.campaign.update({ where: { id: campaignId }, data: { compareAtPolicy: { kind: "set-to-baseline" } as never } });
      // Shopify keeps the price and quietly drops one variant's compare-at.
      chaos.fake.distortStoredCompareAt = (requested, variantGid) => (variantGid === dropped ? null : requested);

      const outcome = await chaos.apply({ forcePath: path });
      expect(outcome.clean, "a run whose strike-through did not land reported clean").toBe(false);

      const rows = await ledgerOf(outcome.runId);
      const row = rows.find((r) => r.variantGid === dropped)!;
      expect(row.status).toBe("FAILED");
      expect(row.failureReason).toMatch(/compare-at price: expected .*found none/);
      for (const other of rows.filter((r) => r.variantGid !== dropped)) expect(other.status, other.variantGid).toBe("VERIFIED");
      expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status).toBe("PARTIAL");
    });
  });
});
