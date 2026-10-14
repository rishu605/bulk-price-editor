/**
 * An "Increase by" campaign never lowers a price (#923).
 *
 * Every rounding profile rounds to the *nearest* ending, so a rise smaller than the
 * distance to the ending below rounded down, past the original: 5% up on 6.10 is 6.405,
 * nearest .99 is 5.99, and the run wrote it. The mirror of #825, where a discount rounded
 * up. Now an increase that would land below the original takes the next ending above.
 *
 * Asserted against the store the fake Shopify ends up holding, and against what the
 * editor's preview promised first, since the two share `resolve()` and must not disagree.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { parseMoney } from "../../app/lib/money/money";
import { previewDraft } from "../../app/services/campaigns/draft-preview.server";
import { withChaos, type ChaosContext } from "../harness/scenario";

/** Sets one variant's normal price everywhere the fixture recorded it. */
async function priceAt(chaos: ChaosContext, variantGid: string, minor: number) {
  const { shopId } = chaos.fixture;
  chaos.fake.variants.get(variantGid)!.price = (minor / 100).toFixed(2);
  chaos.fixture.baseline.set(variantGid, minor);
  await prisma.variantIndex.updateMany({ where: { shopId, variantGid }, data: { price: BigInt(minor) } });
  await prisma.baseline.updateMany({ where: { shopId, variantGid, supersededAt: null }, data: { basePrice: BigInt(minor) } });
  await prisma.priceSurfaceEntry.updateMany({ where: { shopId, variantGid, surfaceKind: "BASE" }, data: { livePrice: BigInt(minor) } });
}

describe("chaos: 5% up, rounded to .99", () => {
  it("never writes a price below the original, and the preview said so first", async () => {
    await withChaos("increase-never-lowers", { catalog: { products: 4, variantsPerProduct: 1 }, percent: 5 }, async (chaos) => {
      const { shopId, campaignId, variantGids } = chaos.fixture;
      const [ragged, whole, ticket, ordinary] = variantGids;

      // [baseline, what the run must write, what nearest rounding used to write]
      const cases = new Map([
        [ragged, [610, "6.99", "5.99"]], // 6.405: nearest .99 is 5.99, below 6.10
        [whole, [700, "7.99", "6.99"]], // 7.35: nearest .99 is 6.99, below 7.00
        [ticket, [595, "5.99", "5.99"]], // 6.2475: nearest is 5.99, a rise from 5.95, so it stands
        [ordinary, [5_000, "52.99", "52.99"]], // 52.50: nearest is 52.99, untouched
      ] as const);
      for (const [gid, [minor]] of cases) await priceAt(chaos, gid, minor);

      const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
      await prisma.campaign.update({
        where: { id: campaignId },
        data: { schedule: { ...(campaign.schedule as object), rounding: { default: "charm99", byCurrency: {} } } as never },
      });

      // The preview, from the same baselines, before anything is written.
      const preview = await previewDraft(
        shopId,
        {
          ast: { groups: [] },
          rule: { kind: "percent-change", percent: 5 },
          compareAtPolicy: { kind: "leave" },
          rounding: { default: "charm99", byCurrency: {} },
          priority: 500,
        },
        100,
      );
      const promised = new Map(preview.rows.map((row) => [row.variantGid, row.after]));

      const run = await chaos.apply();
      await chaos.expectHonest(run.runId);

      for (const [gid, [minor, expected, before]] of cases) {
        const live = chaos.fake.priceOf(gid)!;
        expect(
          parseMoney(live, "USD").amount,
          `"Increase by 5%" lowered ${gid} from ${(minor / 100).toFixed(2)} to ${live}` +
            (before !== expected ? ` (nearest .99 gave ${before})` : ""),
        ).toBeGreaterThanOrEqual(minor);
        expect(live).toBe(expected);
        expect(promised.get(gid), `the preview promised ${promised.get(gid)} for ${gid}, the store holds ${live}`).toBe(live);
      }
    });
  });
});
