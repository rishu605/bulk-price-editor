/**
 * Pulling one variant out of a running campaign, and a revert that respects an edit
 * somebody made by hand.
 *
 * Here rather than in the unit suite because the claims are about durability, and
 * durability is not something a pure test can check. "Excluded from subsequent runs"
 * means a row in Postgres that a later run reads; "the ledger records the partial
 * revert" means a run somebody can open in six weeks. Both need the real engine
 * against a real database, which is the rig this directory already provides.
 *
 * It earns its place among the chaos scenarios on the second half. The rollback
 * report exists because a merchant edits a price while a sale is running, so the test
 * does exactly that -- reaches past the app and changes the store behind its back --
 * and then asserts the revert notices, asks, and honours the answer instead of
 * silently overwriting a deliberate decision.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import {
  reinstateVariant,
  revertVariant,
  rollbackReport,
  rollbackReportCsv,
} from "../../app/services/campaigns/index.server";
import { chaosAdminClient } from "../harness/http-client";
import { ledgerOf, withChaos } from "../harness/scenario";

describe("chaos: one variant reverted out of a running campaign", () => {
  it("recomputes it, ledgers the revert, and keeps it out of later runs", async () => {
    await withChaos(
      "variant-revert",
      { catalog: { products: 8, variantsPerProduct: 2 }, percent: -25 },
      async (chaos) => {
        const client = chaosAdminClient(chaos.server.endpoint());
        const { shopId, campaignId, baseline } = chaos.fixture;

        const applied = await chaos.apply();
        await chaos.expectHonest(applied.runId);

        const victim = chaos.fixture.variantGids[0];
        const base = baseline.get(victim)!;
        expect(chaos.fake.priceOf(victim)).toBe(((base * 0.75) / 100).toFixed(2));

        // ---------------------------------------------------- the single revert
        const result = await revertVariant(shopId, campaignId, victim, client);
        expect(result.changed).toBe(true);
        expect(result.outcome?.clean).toBe(true);

        // Back to its own baseline, because nothing else covers it.
        expect(chaos.fake.priceOf(victim)).toBe((base / 100).toFixed(2));

        // Every other variant is untouched. A single-variant revert that quietly
        // ended the sale for everyone would be far worse than not offering one.
        for (const gid of chaos.fixture.variantGids.slice(1)) {
          const expected = Math.round(baseline.get(gid)! * 0.75);
          expect(chaos.fake.priceOf(gid)).toBe((expected / 100).toFixed(2));
        }

        // -------------------------------------------------- durably excluded
        const record = await prisma.campaign.findUniqueOrThrow({
          where: { id: campaignId },
          select: { excludedVariantGids: true, status: true },
        });
        expect(record.excludedVariantGids).toContain(victim);

        // The campaign is still running. A scoped run must not decide the fate of
        // the variants it never looked at.
        expect(record.status).toBe("ACTIVE");

        // Ledgered as a revert, not as an apply.
        const scopedRun = await prisma.campaignRun.findFirstOrThrow({
          where: { campaignId, kind: "REVERT" },
          orderBy: { createdAt: "desc" },
        });
        const scopedRows = await ledgerOf(scopedRun.id);
        expect(scopedRows).toHaveLength(1);
        expect(scopedRows[0].variantGid).toBe(victim);
        expect(scopedRows[0].status).toBe("VERIFIED");
        expect(Number(scopedRows[0].intendedPrice)).toBe(base);

        // ------------------------------------- and it stays out on the next run
        // The claim that makes this worth offering. A revert undone by tonight's
        // scheduled run is worse than no revert at all.
        const rerun = await chaos.apply();
        await chaos.expectHonest(rerun.runId);
        expect(chaos.fake.priceOf(victim)).toBe((base / 100).toFixed(2));

        const rerunRows = await ledgerOf(rerun.runId);
        expect(rerunRows.some((row) => row.variantGid === victim)).toBe(false);

        // ------------------------------------------------------- and back in
        const back = await reinstateVariant(shopId, campaignId, victim, client);
        expect(back.changed).toBe(true);
        expect(chaos.fake.priceOf(victim)).toBe(((base * 0.75) / 100).toFixed(2));
      },
    );
  });
});

describe("chaos: a revert that respects a merchant's edit", () => {
  it("reports the drifted row, leaves it when asked, and ledgers the decision", async () => {
    await withChaos(
      "rollback-report",
      { catalog: { products: 6, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const { shopId, campaignId, baseline } = chaos.fixture;

        const applied = await chaos.apply();
        await chaos.expectHonest(applied.runId);

        // A person changes a price in Shopify while the sale is running -- the whole
        // reason this report exists. Written straight into the store and the mirror,
        // never through the app, because a drift the app made is not drift.
        const edited = chaos.fixture.variantGids[0];
        const deleted = chaos.fixture.variantGids[1];
        const handPrice = 4_242;

        chaos.fake.variants.get(edited)!.price = (handPrice / 100).toFixed(2);
        await prisma.priceSurfaceEntry.updateMany({
          where: { shopId, variantGid: edited, surfaceKind: "BASE", priceListGid: "" },
          data: { livePrice: BigInt(handPrice) },
        });

        // And one deleted mid-sale, which must be reported as deleted rather than as
        // a conflict somebody has to resolve (E4).
        chaos.fake.deleteVariant(deleted);
        await prisma.variantIndex.updateMany({
          where: { shopId, variantGid: deleted },
          data: { deletedAt: new Date() },
        });

        // ------------------------------------------------------- the report
        const report = await rollbackReport(shopId, campaignId);
        expect(report.straightforward).toBe(false);
        expect(report.counts.drifted).toBe(1);
        expect(report.counts.deleted).toBe(1);

        const drifted = report.rows.find((row) => row.variantGid === edited);
        expect(drifted?.kind).toBe("drifted");
        expect(drifted?.live).toContain("42.42");
        expect(drifted?.revertsTo).toContain((baseline.get(edited)! / 100).toFixed(2));

        // Rows needing a decision come first, so they are not below the fold.
        expect(report.rows[0].kind).toBe("drifted");

        // Exportable, and intact.
        const csv = rollbackReportCsv(report);
        expect(csv.split("\n")[0]).toBe("variant_gid,title,state,applied,live_now,reverts_to");
        expect(csv).toContain(edited);

        // -------------------------------------------- revert, keeping the edit
        const reverted = await chaos.revert({ skipVariantGids: [edited] });
        await chaos.expectHonest(reverted.runId);

        // The merchant's price survived.
        expect(chaos.fake.priceOf(edited)).toBe((handPrice / 100).toFixed(2));

        // Everything else went back to baseline.
        for (const gid of chaos.fixture.variantGids.slice(2)) {
          expect(chaos.fake.priceOf(gid)).toBe((baseline.get(gid)! / 100).toFixed(2));
        }

        // The decision is in the ledger, not merely in somebody's memory of clicking
        // a checkbox.
        const rows = await ledgerOf(reverted.runId);
        const spared = rows.find((row) => row.variantGid === edited);
        expect(spared?.status).toBe("SKIPPED");
        expect(spared?.failureReason).toMatch(/keep that edit/i);
      },
    );
  });
});
