/**
 * Every run records the path its prices took: one call per product, or a bulk operation (#1055).
 *
 * `campaign_runs.writePath` was in the schema and never written, so a slow run could not be
 * told from a slow path after the fact, and an estimate of a campaign's next run (#829) had
 * nothing to read Shopify's bulk queue time from.
 *
 * Through the real apply, revert and "Revert this variant".
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { revertVariant } from "../../app/services/campaigns/variant-revert.server";
import { chaosAdminClient } from "../harness/http-client";
import { withChaos } from "../harness/scenario";

const pathOf = async (runId: string) => (await prisma.campaignRun.findUniqueOrThrow({ where: { id: runId } })).writePath;

describe("chaos: a run's write path", () => {
  it("is recorded on every run: sync, bulk, and one over a single variant", async () => {
    await withChaos("write-path-recorded", { catalog: { products: 3, variantsPerProduct: 1 }, percent: -10 }, async (chaos) => {
      const { shopId, campaignId, variantGids } = chaos.fixture;

      const applied = await chaos.apply();
      await chaos.expectHonest(applied.runId);
      expect(await pathOf(applied.runId), "an apply of three variants did not record its path").toBe("SYNC");

      const one = await revertVariant(shopId, campaignId, variantGids[0], chaosAdminClient(chaos.server.endpoint()), { actor: "chaos" });
      expect(one.outcome?.clean).toBe(true);
      expect(await pathOf(one.outcome!.runId)).toBe("SYNC");

      const reverted = await chaos.revert({ forcePath: "bulk" });
      await chaos.expectHonest(reverted.runId);
      expect(await pathOf(reverted.runId), "a bulk revert did not record its path").toBe("BULK");
    });
  });
});
