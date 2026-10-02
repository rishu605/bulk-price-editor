/**
 * The campaign page makes no plan while a run is writing its campaign (#803).
 *
 * A plan loads every candidate and baseline in scope, and the page made one on every load
 * and tab switch -- including while the campaign's own 102,132-variant run was writing the
 * same tables. A merchant watching the run held connections it needed; the pool ran dry,
 * every shop's pages went blank, and the run died of a pool timeout (#802).
 *
 * Counted at the candidate load, which is where a plan's cost is.
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { pagePreview } from "../../app/services/campaigns/preview.server";
import { withChaos } from "../harness/scenario";

const loads = { count: 0 };

vi.mock("../../app/services/campaigns/candidates.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/services/campaigns/candidates.server")>();
  return {
    ...actual,
    loadCandidates: async (...args: Parameters<typeof actual.loadCandidates>) => {
      loads.count++;
      return actual.loadCandidates(...args);
    },
  };
});

describe("chaos: the campaign page while its run writes", () => {
  it("plans when the campaign is still, and not while a run writes it", async () => {
    await withChaos("page-preview-writing", { catalog: { products: 3, variantsPerProduct: 1 }, percent: -10 }, async (chaos) => {
      const { shopId, campaignId } = chaos.fixture;

      loads.count = 0;
      const still = await pagePreview(shopId, campaignId);
      expect(still.writing).toBeUndefined();
      expect(still.counts.planned).toBe(3);
      expect(loads.count, "the control: a still campaign is planned").toBeGreaterThan(0);

      for (const status of ["APPLYING", "REVERTING"] as const) {
        await prisma.campaign.update({ where: { id: campaignId }, data: { status } });
        loads.count = 0;
        const writing = await pagePreview(shopId, campaignId);
        expect(loads.count, `a page load planned a campaign that was ${status}`).toBe(0);
        expect(writing.writing).toMatch(new RegExp(`is being ${status === "APPLYING" ? "applied" : "reverted"} right now`));
        expect(writing.rows).toEqual([]);
        expect(writing.name).toBe(`chaos/page-preview-writing`);
      }
    });
  });
});
