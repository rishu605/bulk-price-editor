/**
 * A Partial campaign's banner says what its last run actually got done (#927).
 *
 * It always read "Some prices were written and verified; others were not" -- including
 * over a bulk apply that had stopped after Shopify accepted it, with 0 rows verified and
 * every row still Writing, directly above a Runs summary that said none was read back yet.
 *
 * Through the campaign page's own loader, on ledgers shaped like the three cases.
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { withChaos } from "../harness/scenario";

let pending = { shop: "" };

vi.mock("../../app/shopify.server", () => ({
  authenticate: {
    admin: async () => ({
      session: { shop: pending.shop },
      sessionToken: { sub: "42" },
      admin: {
        async graphql() {
          throw new Error("the page's loader made an Admin API call");
        },
      },
    }),
  },
}));

async function banner(campaignId: string): Promise<string> {
  const { loader } = await import("../../app/routes/app.campaigns.$id");
  const page = (await loader({
    request: new Request(`https://example.invalid/app/campaigns/${campaignId}`),
    params: { id: campaignId },
    context: {},
  } as never)) as { lifecycle: { label: string; explanation: string } };
  return page.lifecycle.explanation;
}

/** A Partial campaign whose last run left these ledger statuses behind. */
async function partialWith(shopId: string, campaignId: string, variantGids: string[], kind: "APPLY" | "REVERT", statuses: string[]) {
  await prisma.campaign.update({ where: { id: campaignId }, data: { status: "PARTIAL" } });
  const run = await prisma.campaignRun.create({
    data: {
      shopId,
      campaignId,
      kind,
      status: "PARTIAL",
      occurrenceKey: `chaos-927-${kind}-${statuses.join("-")}`,
      writePath: "BULK",
      plannedRows: statuses.length,
      verifiedRows: statuses.filter((s) => s === "VERIFIED").length,
    },
  });
  await prisma.variantChange.createMany({
    data: statuses.map((status, i) => ({
      runId: run.id,
      shopId,
      variantGid: variantGids[i],
      surfaceKind: "BASE" as const,
      currency: "USD",
      intendedPrice: 1000n,
      status: status as never,
    })),
  });
}

describe("chaos: the banner on a Partial campaign", () => {
  it("says prices were sent and not read back when a bulk apply verified none", async () => {
    await withChaos("partial-banner-sent", { catalog: { products: 4, variantsPerProduct: 1 } }, async (chaos) => {
      const { shopId, domain, campaignId, variantGids } = chaos.fixture;
      pending = { shop: domain };
      await partialWith(shopId, campaignId, variantGids, "APPLY", ["WRITING", "WRITING", "WRITING", "WRITING"]);
      const text = await banner(campaignId);
      expect(text, "the banner claimed prices were verified over a run that verified none").not.toMatch(/verified;/);
      expect(text).toMatch(/sent to Shopify, but none has been read back yet/);
    });
  });

  it("claims no change at all when a run stopped before writing anything", async () => {
    await withChaos("partial-banner-nothing", { catalog: { products: 2, variantsPerProduct: 1 } }, async (chaos) => {
      const { shopId, domain, campaignId, variantGids } = chaos.fixture;
      pending = { shop: domain };
      await partialWith(shopId, campaignId, variantGids, "APPLY", ["FAILED", "PENDING"]);
      const text = await banner(campaignId);
      expect(text).not.toMatch(/were written and verified|sent to Shopify/);
      expect(text).toMatch(/stopped before any price was written and verified/);
    });
  });

  it("keeps its wording when some prices were verified and others were not", async () => {
    await withChaos("partial-banner-some", { catalog: { products: 3, variantsPerProduct: 1 } }, async (chaos) => {
      const { shopId, domain, campaignId, variantGids } = chaos.fixture;
      pending = { shop: domain };
      await partialWith(shopId, campaignId, variantGids, "REVERT", ["VERIFIED", "FAILED", "WRITING"]);
      const text = await banner(campaignId);
      expect(text).toMatch(/^Some prices were put back and verified; others were not/);
    });
  });
});
