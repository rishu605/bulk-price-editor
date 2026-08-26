/**
 * The one-page result a campaign ends with, against a real database.
 *
 * `run-result.ts` is tested pure, which proves the arithmetic and nothing about the query
 * that feeds it. A wrong table name, a status cast that silently returns nothing, or a
 * join that drops every cost all typecheck perfectly and produce a page that cheerfully
 * reports zero — the exact failure mode this product exists to prevent, wearing a summary
 * banner.
 *
 * So these assert what a merchant reads, against ledger rows a real run wrote.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { withChaos } from "../harness/scenario";
import { isVariantWrite } from "../harness/faults";

describe("chaos: what the result page says a run did", () => {
  it("reports the prices a clean run actually changed, and calls it clean", async () => {
    await withChaos(
      "campaign-result-clean",
      { catalog: { products: 4, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const { campaignResult } = await import("../../app/services/campaigns/result.server");

        const outcome = await chaos.apply();
        const runId = await chaos.latestRunId("APPLY");
        await chaos.expectHonest(runId);

        const result = await campaignResult(chaos.fixture.shopId, runId);

        expect(result).not.toBeNull();
        expect(result!.clean).toBe(true);
        expect(result!.counts.failed).toBe(0);
        expect(result!.counts.pending).toBe(0);

        // Two independent paths to the same fact: the runner counted rows as it wrote
        // them, this counted them afterwards from the ledger. Disagreement means one of
        // them is describing a run that did not happen.
        expect(result!.counts.verified).toBe(outcome.verified);
        expect(result!.counts.failed).toBe(outcome.failed);
        expect(result!.counts.unverified).toBe(outcome.unverified);
        expect(result!.clean).toBe(outcome.clean);
        expect(result!.counts.verified).toBeGreaterThan(0);

        const inLedger = await prisma.variantChange.count({
          where: { shopId: chaos.fixture.shopId, runId },
        });
        expect(result!.counts.total).toBe(inLedger);
      },
    );
  });

  it("computes margin from the cost the catalogue actually holds", async () => {
    await withChaos(
      "campaign-result-margin",
      { catalog: { products: 3, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const { shopId } = chaos.fixture;
        const { campaignResult } = await import("../../app/services/campaigns/result.server");

        // A known cost on every baseline, so the expected margin is arithmetic rather
        // than whatever the fixture happened to seed. The baseline, not the mirror: that
        // is where the resolver reads cost, and the two must not disagree.
        const baselines = await prisma.baseline.findMany({
          where: { shopId, surfaceKind: "BASE", priceListGid: "", supersededAt: null },
          select: { id: true, basePrice: true },
        });
        expect(baselines.length).toBeGreaterThan(0);

        for (const baseline of baselines) {
          // Cost at half the pre-campaign price: a 50% margin before, 37.5% after -20%.
          await prisma.baseline.update({
            where: { id: baseline.id },
            data: { cost: baseline.basePrice / 2n },
          });
        }

        await chaos.apply();
        const runId = await chaos.latestRunId("APPLY");
        const result = await campaignResult(shopId, runId);

        // The join found the costs. A broken join reports every product as unknown,
        // which reads as "you have no cost data" and is a lie.
        expect(result!.margin.unknown).toBe(0);
        expect(result!.margin.covered).toBeGreaterThan(0);
        expect(result!.margin.averageBefore).toBeCloseTo(50, 1);
        expect(result!.margin.averageAfter).toBeCloseTo(37.5, 1);
      },
    );
  });

  it("says a product has no cost rather than inventing one", async () => {
    await withChaos(
      "campaign-result-no-cost",
      { catalog: { products: 3, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const { shopId } = chaos.fixture;
        const { campaignResult } = await import("../../app/services/campaigns/result.server");

        await prisma.baseline.updateMany({
          where: { shopId, surfaceKind: "BASE", priceListGid: "", supersededAt: null },
          data: { cost: null },
        });

        await chaos.apply();
        const runId = await chaos.latestRunId("APPLY");
        const result = await campaignResult(shopId, runId);

        expect(result!.margin.covered).toBe(0);
        expect(result!.margin.unknown).toBeGreaterThan(0);
        // Not zero-margin, not "0%" — nothing at all.
        expect(result!.margin.averageAfter).toBe(0);
        expect(result!.margin.belowCost).toHaveLength(0);
      },
    );
  });

  it("keeps a reverted run finished, rather than reporting it as still going", async () => {
    await withChaos(
      "campaign-result-reverted",
      { catalog: { products: 3, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const { shopId } = chaos.fixture;
        const { campaignResult } = await import("../../app/services/campaigns/result.server");

        await chaos.apply();
        const applyRunId = await chaos.latestRunId("APPLY");
        await chaos.revert();

        const result = await campaignResult(shopId, applyRunId);

        // Whatever the revert did to the original rows, the apply run is over. A status
        // this code does not recognise falls into "pending", which would report a
        // finished campaign as still running — forever, and on every page load.
        expect(result!.counts.pending).toBe(0);
        expect(result!.clean).toBe(true);
        expect(result!.summary).not.toContain("still to run");
      },
    );
  });

  it("refuses to call a run clean when a row never got written", async () => {
    await withChaos(
      "campaign-result-partial",
      { catalog: { products: 6, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const { campaignResult } = await import("../../app/services/campaigns/result.server");

        // Break every write permanently: the run cannot finish, and the result page must
        // say so rather than summarising the rows that happened to get through.
        chaos.arm([{ fault: "server-error", match: isVariantWrite }]);

        await chaos.apply();
        const runId = await chaos.latestRunId("APPLY");

        const result = await campaignResult(chaos.fixture.shopId, runId);

        expect(result!.clean).toBe(false);
        expect(result!.counts.verified + result!.counts.clamped).toBeLessThan(
          result!.counts.total,
        );
        // The sentence a merchant reads must lead with the bad news.
        expect(result!.summary).toMatch(/failed|not read back|still to run/);

        // And nothing unwritten may be counted as a margin outcome.
        expect(result!.margin.covered + result!.margin.unknown).toBe(
          result!.counts.verified + result!.counts.clamped,
        );
      },
    );
  });
});
