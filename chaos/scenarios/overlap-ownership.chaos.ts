/**
 * A sale under a higher-priority sale is told the truth about which variants it prices
 * (#836, #837).
 *
 * Both were found live on dartmode-labs with one probe product and two sales over it:
 *
 *  - #836. A (priority 100) applied, then B (priority 200) took the variant over. A's
 *    rollback report called it "Changed since … someone edited those on purpose" and the
 *    header swapped Revert for "Review 1 edited before reverting". Nobody edited it: B wrote
 *    it, and B's price is exactly what reverting A leaves there.
 *  - #837. B applied first, then A. A's Apply dialog called B's variant "still owned by this
 *    campaign". Once B was reverted and handed the variant to A, A's own Revert dialog said
 *    "0 variants are priced by this campaign" -- and its revert then wrote it.
 *
 * Driven through `previewCampaign`, `rollbackReport` and `runCampaign` against the fake
 * store. The fixture's campaign is A; B is created here and covers one variant of A's.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { describeState } from "../../app/lib/lifecycle/transitions";
import { createCampaign } from "../../app/services/campaigns/model.server";
import { previewCampaign } from "../../app/services/campaigns/preview.server";
import { rollbackReport } from "../../app/services/campaigns/rollback-report.server";
import { runCampaign } from "../../app/services/campaigns/run.server";
import { chaosAdminClient } from "../harness/http-client";
import { withChaos, type ChaosContext } from "../harness/scenario";

const dollars = (minor: number) => (minor / 100).toFixed(2);

/** B: the higher-priority sale, over only the first of A's variants. */
async function higherSale(chaos: ChaosContext, percent: number) {
  const { shopId, variantGids } = chaos.fixture;
  await prisma.variantIndex.updateMany({
    where: { shopId, variantGid: variantGids[0] },
    data: { tags: ["chaos", "chaos-b"] },
  });
  return createCampaign(shopId, {
    name: "chaos/higher-sale",
    priority: 200,
    rule: { kind: "percent-change", percent },
    compareAtPolicy: { kind: "leave" },
    rounding: { default: "none", byCurrency: {} },
    ast: { groups: [{ conditions: [{ field: "tag", value: "chaos-b" }] }] },
    schedule: { kind: "manual" },
  } as never);
}

describe("chaos: a sale under a higher-priority sale (#836, #837)", () => {
  it("does not call the higher sale's price an edit, and still reports a real one (#836)", async () => {
    await withChaos("overlap-ownership-836", { catalog: { products: 3, variantsPerProduct: 1 }, percent: -10 }, async (chaos) => {
      const { shopId, campaignId: lower, variantGids, baseline } = chaos.fixture;
      const client = chaosAdminClient(chaos.server.endpoint());
      const [taken, ...own] = variantGids;
      const at = (gid: string, factor: number) => Math.round(baseline.get(gid)! * factor);
      await prisma.campaign.update({ where: { id: lower }, data: { priority: 100 } });

      // A, 10% off, applied over all three.
      await chaos.expectHonest((await chaos.apply()).runId);

      // B, 15% off at priority 200, takes the first one over.
      const higher = await higherSale(chaos, -15);
      const applied = await runCampaign(shopId, higher.id, client, { actor: "chaos", verifySampleRate: 1 });
      expect(applied.clean).toBe(true);
      expect(chaos.fake.priceOf(taken), "B did not take the variant over").toBe(dollars(at(taken, 0.85)));

      const report = await rollbackReport(shopId, lower);
      const row = report.rows.find((r) => r.variantGid === taken);
      expect(row, "A's report dropped the variant it wrote").toBeDefined();
      expect(row!.live).toBe(row!.revertsTo);
      expect(row!.kind, "B's price read as somebody's edit").toBe("unaffected");
      expect(report.counts.drifted, "the report counted a takeover as changed").toBe(0);
      expect(report.straightforward, "the header would offer Review instead of plain Revert").toBe(true);

      // The Revert dialog counts what A prices: its own two, not the one B holds.
      expect(report.counts.total - report.counts.unaffected).toBe(own.length);
      for (const gid of own) expect(report.rows.find((r) => r.variantGid === gid)?.kind).toBe("clean");

      // A real hand edit -- neither A's price nor B's -- is still a question.
      const handPrice = at(taken, 0.95);
      chaos.fake.addVariant({ variantGid: taken, productGid: chaos.fixture.productOf.get(taken)!, price: dollars(handPrice), compareAtPrice: null });
      await prisma.priceSurfaceEntry.updateMany({
        where: { shopId, variantGid: taken, surfaceKind: "BASE", priceListGid: "" },
        data: { livePrice: BigInt(handPrice) },
      });
      const edited = await rollbackReport(shopId, lower);
      expect(edited.rows.find((r) => r.variantGid === taken)?.kind, "a hand edit went unreported").toBe("drifted");
      expect(edited.counts.drifted).toBe(1);
      expect(edited.straightforward).toBe(false);
    });
  });

  it("names the higher sale while it holds the variant, and counts the variant once it is handed back (#837)", async () => {
    await withChaos("overlap-ownership-837", { catalog: { products: 3, variantsPerProduct: 1 }, percent: -10 }, async (chaos) => {
      const { shopId, campaignId: lower, variantGids, baseline } = chaos.fixture;
      const client = chaosAdminClient(chaos.server.endpoint());
      const [taken, ...own] = variantGids;
      const at = (gid: string, factor: number) => Math.round(baseline.get(gid)! * factor);
      await prisma.campaign.update({ where: { id: lower }, data: { priority: 100 } });

      // B first: 30% off the first variant at priority 200.
      const higher = await higherSale(chaos, -30);
      expect((await runCampaign(shopId, higher.id, client, { actor: "chaos", verifySampleRate: 1 })).clean).toBe(true);
      expect(chaos.fake.priceOf(taken)).toBe(dollars(at(taken, 0.7)));

      // A's Apply dialog: the variant B prices is B's, by name, not "still owned by this campaign".
      const before = await previewCampaign(shopId, lower, { client });
      expect(before.counts.noop).toBe(1);
      expect(before.alreadyCorrect, "the apply dialog has no owner for the variant already at its price").toEqual({
        own: 0,
        unpriced: 0,
        others: [expect.objectContaining({ campaignId: higher.id, name: "chaos/higher-sale", variants: 1 })],
      });
      // Not outranked everywhere: A prices the other two.
      expect(before.outrankedBy ?? []).toEqual([]);

      await chaos.expectHonest((await chaos.apply()).runId);
      for (const gid of own) expect(chaos.fake.priceOf(gid)).toBe(dollars(at(gid, 0.9)));
      expect(chaos.fake.priceOf(taken), "A wrote under B").toBe(dollars(at(taken, 0.7)));

      // Re-planned after the apply: A's own two are at A's price, and the third is B's.
      const after = await previewCampaign(shopId, lower, { client });
      expect(after.alreadyCorrect).toEqual({
        own: own.length,
        unpriced: 0,
        others: [expect.objectContaining({ campaignId: higher.id, variants: 1 })],
      });

      // Before the handover A prices its own two, not B's.
      const underB = await rollbackReport(shopId, lower);
      expect(underB.rows.map((r) => r.variantGid).sort()).toEqual([...own].sort());

      // B ends, and its revert hands the variant to A (rule 6).
      expect((await runCampaign(shopId, higher.id, client, { actor: "chaos", revert: true, verifySampleRate: 1 })).clean).toBe(true);
      expect(chaos.fake.priceOf(taken), "B's revert did not hand the variant to A").toBe(dollars(at(taken, 0.9)));

      // A's Revert dialog counts it, and it is clean -- A's price, which nobody edited.
      const handedBack = await rollbackReport(shopId, lower);
      const row = handedBack.rows.find((r) => r.variantGid === taken);
      expect(row, "A's report does not know it prices the variant B handed back").toBeDefined();
      expect(row!.kind).toBe("clean");
      expect(row!.revertsTo).toBe(dollars(baseline.get(taken)!));
      expect(handedBack.counts.total - handedBack.counts.unaffected, "the Revert dialog understates what it rewrites").toBe(variantGids.length);
      expect(handedBack.straightforward).toBe(true);

      // And its revert writes it back to its baseline, with the other two.
      const reverted = await chaos.revert();
      await chaos.expectHonest(reverted.runId);
      for (const gid of variantGids) expect(chaos.fake.priceOf(gid), "A's revert left a price behind").toBe(dollars(baseline.get(gid)!));
    });
  });

  it("does not say the storefront shows the campaign's price while a higher sale holds every variant (#837)", async () => {
    await withChaos("overlap-ownership-status", { catalog: { products: 1, variantsPerProduct: 1 }, percent: -10 }, async (chaos) => {
      const { shopId, campaignId: lower, variantGids, baseline } = chaos.fixture;
      const client = chaosAdminClient(chaos.server.endpoint());
      await prisma.campaign.update({ where: { id: lower }, data: { priority: 100 } });

      const higher = await higherSale(chaos, -30);
      await runCampaign(shopId, higher.id, client, { actor: "chaos", verifySampleRate: 1 });
      const applied = await chaos.apply();
      await chaos.expectHonest(applied.runId);
      expect(applied.planned).toBe(0);
      expect(chaos.fake.priceOf(variantGids[0])).toBe(dollars(Math.round(baseline.get(variantGids[0])! * 0.7)));

      const preview = await previewCampaign(shopId, lower, { client });
      expect(preview.outrankedBy).toEqual(["chaos/higher-sale"]);
      const status = describeState("ACTIVE", { outrankedBy: preview.outrankedBy });
      expect(status.explanation, "the status line claims a price the storefront does not show").not.toContain(
        "Your storefront shows the campaign price",
      );
      expect(status.explanation).toContain("chaos/higher-sale");

      // Once B ends, A's price is live and the status line says so again.
      await runCampaign(shopId, higher.id, client, { actor: "chaos", revert: true, verifySampleRate: 1 });
      const handed = await previewCampaign(shopId, lower, { client });
      expect(handed.outrankedBy ?? []).toEqual([]);
      expect(describeState("ACTIVE", { outrankedBy: handed.outrankedBy }).explanation).toContain(
        "Your storefront shows the campaign price",
      );
    });
  });
});
