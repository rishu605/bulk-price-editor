/**
 * The guard on the most destructive thing this app does.
 *
 * Recapture replaces every baseline in scope with today's live price. Run it while a
 * sale is on and the sale prices *become* the merchant's normal prices — permanently,
 * for every campaign afterwards, because every campaign computes from the baseline.
 * A 20%-off campaign applied to an already-discounted baseline compounds, and the
 * merchant has no way to notice until the margin is gone.
 *
 * The dashboard used to offer this as one click behind a paragraph of warning. This
 * proves the replacement actually stops it, against a real campaign holding real
 * prices.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { planRecapture, recapture } from "../../app/services/recapture.server";
import { DANGEROUS_PHRASE } from "../../app/lib/baselines/recapture";
import { withChaos } from "../harness/scenario";

describe("chaos: recapturing baselines", () => {
  it("refuses to enshrine a live sale without a typed confirmation", async () => {
    await withChaos(
      "recapture",
      { catalog: { products: 5, variantsPerProduct: 2 }, percent: -25 },
      async (chaos) => {
        const { shopId, variantGids, baseline } = chaos.fixture;

        // Nothing running: recapture is unremarkable and asks for nothing extra.
        const quiet = await planRecapture(shopId);
        expect(quiet.risk).toBe("safe");
        expect(quiet.confirmationPhrase).toBeNull();

        // Now put the catalogue on sale for real.
        const applied = await chaos.apply();
        await chaos.expectHonest(applied.runId);

        const atRisk = await planRecapture(shopId);
        expect(atRisk.risk).toBe("overlaps-active-campaign");
        expect(atRisk.overlaps[0].variants).toBe(variantGids.length);
        expect(atRisk.warning).toContain("new normal");

        // Unconfirmed, it refuses — and the message names the campaign rather than
        // saying something vague about danger.
        await expect(recapture(shopId, {})).rejects.toThrow(/new normal|permanently/i);

        // And it refused without touching anything. This is the assertion that
        // matters: a guard that warns after writing is not a guard.
        for (const gid of variantGids) {
          const current = await prisma.baseline.findFirstOrThrow({
            where: { shopId, variantGid: gid, supersededAt: null },
          });
          expect(Number(current.basePrice)).toBe(baseline.get(gid));
        }
        expect(await prisma.baseline.count({ where: { shopId, source: "RECAPTURE" } })).toBe(0);
      },
    );
  });

  it("goes ahead when the merchant types the words, and keeps the old baseline", async () => {
    await withChaos(
      "recapture-confirmed",
      { catalog: { products: 3, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const { shopId, variantGids, baseline } = chaos.fixture;

        const applied = await chaos.apply();
        await chaos.expectHonest(applied.runId);

        const result = await recapture(shopId, {
          confirmation: DANGEROUS_PHRASE,
          actor: "staff:1",
        });
        expect(result.captured).toBe(variantGids.length);

        // The sale price is now the baseline — which is exactly what the merchant was
        // warned about and chose.
        const gid = variantGids[0];
        const current = await prisma.baseline.findFirstOrThrow({
          where: { shopId, variantGid: gid, supersededAt: null },
        });
        expect(Number(current.basePrice)).toBe(Math.round(baseline.get(gid)! * 0.8));
        expect(current.source).toBe("RECAPTURE");

        // Append-only: the real price is still there, marked superseded. Nothing is
        // destroyed, which is what makes a mistaken recapture traceable.
        const previous = await prisma.baseline.findFirstOrThrow({
          where: { shopId, variantGid: gid, supersededAt: { not: null } },
        });
        expect(Number(previous.basePrice)).toBe(baseline.get(gid));

        // And the whole thing is in the audit log, with the campaigns it overrode.
        const entry = await prisma.auditLogEntry.findFirstOrThrow({
          where: { shopId, action: "baselines.recapture" },
          orderBy: { createdAt: "desc" },
        });
        expect(entry.actor).toBe("staff:1");
        expect(JSON.stringify(entry.after)).toContain("overActiveCampaigns");
      },
    );
  });

  it("only counts campaigns that actually overlap the scope", async () => {
    await withChaos(
      "recapture-scoped",
      { catalog: { products: 4, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const { shopId, variantGids } = chaos.fixture;

        const applied = await chaos.apply();
        await chaos.expectHonest(applied.runId);

        // A frozen segment holding one variant the campaign does cover.
        const { createSegment } = await import("../../app/services/segments-crud.server");
        const overlapping = await createSegment(shopId, {
          name: `recapture-overlap-${chaos.seed}`,
          kind: "FROZEN",
          variantGids: [variantGids[0]],
        });

        const plan = await planRecapture(shopId, { segmentId: overlapping.id });
        expect(plan.scope).toBe(1);
        expect(plan.risk).toBe("overlaps-active-campaign");
        expect(plan.overlaps[0].variants).toBe(1);

        // A segment holding a variant nothing is pricing: alarming somebody about a
        // campaign running elsewhere in the catalogue would train them to ignore it.
        const elsewhere = await createSegment(shopId, {
          name: `recapture-elsewhere-${chaos.seed}`,
          kind: "FROZEN",
          variantGids: ["gid://shopify/ProductVariant/not-in-this-campaign"],
        });

        const clear = await planRecapture(shopId, { segmentId: elsewhere.id });
        expect(clear.risk).toBe("safe");
        expect(clear.confirmationPhrase).toBeNull();
      },
    );
  });
});
