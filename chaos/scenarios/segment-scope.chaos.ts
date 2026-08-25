/**
 * A campaign that targets a saved segment.
 *
 * Here because of the size of the failure. A segment-scoped campaign stores an empty
 * inline filter — its scope lives in the segment — and an empty filter matches the
 * *entire catalogue*. If segment resolution ever silently falls through, the campaign
 * does not price nothing, it prices everything: every product in the store discounted
 * by a campaign the merchant scoped to eleven items.
 *
 * That is not a failure a unit test on the resolver can catch, because the resolver is
 * given whatever scope the caller worked out. The question is whether the caller works
 * it out, against a real database, on the same path a run takes.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { createSegment } from "../../app/services/segments-crud.server";
import { ledgerOf, withChaos } from "../harness/scenario";

describe("chaos: a campaign scoped to a segment", () => {
  it("prices the segment's variants and nothing else", async () => {
    await withChaos(
      "segment-scope",
      { catalog: { products: 10, variantsPerProduct: 2 }, percent: -20 },
      async (chaos) => {
        const { shopId, campaignId, variantGids, baseline } = chaos.fixture;

        // Three of twenty. If resolution falls through to the campaign's empty inline
        // filter, all twenty get priced and the assertion below fails loudly.
        const chosen = variantGids.slice(0, 3);
        const segment = await createSegment(shopId, {
          name: `chaos-segment-${chaos.seed}`,
          kind: "FROZEN",
          variantGids: chosen,
        });

        // Point the existing campaign at the segment, both ways a campaign can
        // reference one: the id in its schedule blob, which the run path reads, and
        // the relation, which the delete guard reads.
        const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
        await prisma.campaign.update({
          where: { id: campaignId },
          data: {
            schedule: { ...(campaign.schedule as object), segmentId: segment.id } as never,
            segments: { connect: { id: segment.id } },
          },
        });

        const outcome = await chaos.apply();
        await chaos.expectHonest(outcome.runId);

        const rows = await ledgerOf(outcome.runId);
        expect(rows).toHaveLength(chosen.length);
        expect(rows.map((r) => r.variantGid).sort()).toEqual([...chosen].sort());

        for (const gid of chosen) {
          const expected = Math.round(baseline.get(gid)! * 0.8);
          expect(chaos.fake.priceOf(gid)).toBe((expected / 100).toFixed(2));
        }

        // The other seventeen are untouched. This is the assertion the scenario
        // exists for.
        for (const gid of variantGids.slice(3)) {
          expect(chaos.fake.priceOf(gid)).toBe((baseline.get(gid)! / 100).toFixed(2));
        }
      },
    );
  });

  it("prices nothing when a frozen segment's list is empty", async () => {
    await withChaos(
      "segment-empty",
      { catalog: { products: 4, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const { shopId, campaignId, variantGids, baseline } = chaos.fixture;

        // The boundary that makes the whole mechanism safe. An empty pinned list means
        // "no products", and it must not collapse into an empty filter, which means
        // "every product".
        const segment = await createSegment(shopId, {
          name: `chaos-empty-${chaos.seed}`,
          kind: "FROZEN",
          variantGids: [],
        });

        const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
        await prisma.campaign.update({
          where: { id: campaignId },
          data: { schedule: { ...(campaign.schedule as object), segmentId: segment.id } as never },
        });

        const outcome = await chaos.apply();
        expect(outcome.planned).toBe(0);

        for (const gid of variantGids) {
          expect(chaos.fake.priceOf(gid)).toBe((baseline.get(gid)! / 100).toFixed(2));
        }
      },
    );
  });
});
