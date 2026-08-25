/**
 * Editing costs in bulk, and what that does to a campaign already running.
 *
 * The bulk edit is the easy half. The half that matters: a sale planned when a jacket
 * cost £40 was comfortably above the margin floor. The supplier raises the cost to £55.
 * Nothing about the storefront changed, no run failed, nothing alerts — and the merchant
 * has been losing money on every sale since the moment the cost moved.
 *
 * The only thing that can tell them is the app that knows both numbers.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { withChaos, type ChaosContext } from "../harness/scenario";

async function setCostFloor(chaos: ChaosContext) {
  const shop = await prisma.shop.findUniqueOrThrow({ where: { id: chaos.fixture.shopId } });
  await prisma.shop.update({
    where: { id: chaos.fixture.shopId },
    data: {
      settings: {
        ...((shop.settings ?? {}) as object),
        neverBelowCost: true,
        violationPolicy: "clamp",
        missingCostPolicy: "skip",
      } as never,
    },
  });
}

describe("chaos: editing costs in bulk", () => {
  it("supersedes the baseline rather than editing it, keeping the price untouched", async () => {
    await withChaos(
      "cost-edit-history",
      { catalog: { products: 4, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const { shopId, variantGids, baseline } = chaos.fixture;

        const { editCosts } = await import("../../app/services/cost-edit.server");
        await editCosts(shopId, { groups: [] }, { kind: "share-of-price", percent: 40 });

        for (const gid of variantGids) {
          const current = await prisma.baseline.findFirstOrThrow({
            where: { shopId, variantGid: gid, supersededAt: null },
          });

          // The cost moved and the price did not. Quietly recapturing the price during a
          // cost edit would enshrine whatever the storefront shows as the new normal,
          // which is the single most destructive thing this could do.
          expect(Number(current.cost)).toBe(Math.round(baseline.get(gid)! * 0.4));
          expect(Number(current.basePrice)).toBe(baseline.get(gid));

          // And the old version is still there, because "what did this cost in March" is
          // a question somebody asks after a margin looks wrong.
          const versions = await prisma.baseline.count({ where: { shopId, variantGid: gid } });
          expect(versions).toBe(2);
        }
      },
    );
  });

  it("does not write a version when the cost is unchanged", async () => {
    await withChaos(
      "cost-edit-noop",
      { catalog: { products: 3, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const { shopId } = chaos.fixture;
        const { editCosts } = await import("../../app/services/cost-edit.server");

        await editCosts(shopId, { groups: [] }, { kind: "share-of-price", percent: 40 });
        const after = await prisma.baseline.count({ where: { shopId } });

        const again = await editCosts(shopId, { groups: [] }, {
          kind: "share-of-price",
          percent: 40,
        });

        // A version that says nothing happened is noise in exactly the history somebody
        // reads when they are already confused.
        expect(again.changed).toBe(0);
        expect(await prisma.baseline.count({ where: { shopId } })).toBe(after);
      },
    );
  });

  it("writes nothing on a dry run", async () => {
    await withChaos(
      "cost-edit-dry",
      { catalog: { products: 3, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const { shopId } = chaos.fixture;
        const { editCosts } = await import("../../app/services/cost-edit.server");

        const preview = await editCosts(shopId, { groups: [] }, {
          kind: "share-of-price",
          percent: 40,
        }, { dryRun: true });

        expect(preview.changed).toBe(3);
        expect(await prisma.baseline.count({ where: { shopId, cost: { not: null } } })).toBe(0);
      },
    );
  });

  it("flags a running campaign that a cost rise has put below its floor", async () => {
    await withChaos(
      "cost-edit-invalidates",
      { catalog: { products: 5, variantsPerProduct: 1 }, percent: -30 },
      async (chaos) => {
        const { shopId, variantGids } = chaos.fixture;
        const { editCosts, newlyViolating } = await import(
          "../../app/services/cost-edit.server"
        );

        // Cost at 50% of price. A 30% sale clears it comfortably.
        await editCosts(shopId, { groups: [] }, { kind: "share-of-price", percent: 50 });
        await setCostFloor(chaos);

        const applied = await chaos.apply();
        await chaos.expectHonest(applied.runId);

        // Nothing wrong yet.
        expect(await newlyViolating(shopId)).toEqual([]);

        // The supplier raises everything to 90% of the normal price. The live sale price
        // is now below cost, and nothing about the storefront changed to say so.
        await editCosts(shopId, { groups: [] }, { kind: "share-of-price", percent: 90 });

        const violations = await newlyViolating(shopId);

        expect(violations).toHaveLength(variantGids.length);
        expect(violations[0].campaignId).toBe(chaos.fixture.campaignId);
        expect(violations[0].live.amount).toBeLessThan(violations[0].floor.amount);
        // Named, so a merchant can decide per product whether to honour the sale.
        expect(violations[0].title).toBeTruthy();
      },
    );
  });

  it("flags a cancelled campaign whose prices were never reverted", async () => {
    await withChaos(
      "cost-edit-cancelled",
      { catalog: { products: 3, variantsPerProduct: 1 }, percent: -30 },
      async (chaos) => {
        const { shopId, campaignId } = chaos.fixture;
        const { editCosts, newlyViolating } = await import(
          "../../app/services/cost-edit.server"
        );

        await editCosts(shopId, { groups: [] }, { kind: "share-of-price", percent: 50 });
        await setCostFloor(chaos);

        const applied = await chaos.apply();
        await chaos.expectHonest(applied.runId);

        // Cancelled without reverting. The prices are still on the storefront.
        await prisma.campaign.update({
          where: { id: campaignId },
          data: { status: "CANCELLED" },
        });

        await editCosts(shopId, { groups: [] }, { kind: "share-of-price", percent: 90 });

        // The merchant is losing money on every sale, and the campaign's label has no
        // bearing on that.
        expect((await newlyViolating(shopId)).length).toBeGreaterThan(0);
      },
    );
  });

  it("reports nothing when no cost-based guardrail is configured", async () => {
    await withChaos(
      "cost-edit-no-guardrail",
      { catalog: { products: 3, variantsPerProduct: 1 }, percent: -30 },
      async (chaos) => {
        const { shopId } = chaos.fixture;
        const { editCosts, newlyViolating } = await import(
          "../../app/services/cost-edit.server"
        );

        await editCosts(shopId, { groups: [] }, { kind: "share-of-price", percent: 90 });
        const applied = await chaos.apply();
        await chaos.expectHonest(applied.runId);

        // A merchant who has not asked for a cost floor has not been promised one.
        // Flagging here would be the app inventing a policy and then reporting breaches
        // of it.
        expect(await newlyViolating(shopId)).toEqual([]);
      },
    );
  });

  it("does not flag prices that have been reverted", async () => {
    await withChaos(
      "cost-edit-completed",
      { catalog: { products: 3, variantsPerProduct: 1 }, percent: -30 },
      async (chaos) => {
        const { shopId } = chaos.fixture;
        const { editCosts, newlyViolating } = await import(
          "../../app/services/cost-edit.server"
        );

        await editCosts(shopId, { groups: [] }, { kind: "share-of-price", percent: 50 });
        await setCostFloor(chaos);

        const applied = await chaos.apply();
        await chaos.expectHonest(applied.runId);
        await chaos.revert();

        await editCosts(shopId, { groups: [] }, { kind: "share-of-price", percent: 90 });

        // The ledger rows are REVERTED, so the sale prices are not on the storefront to
        // be below anything. Note this turns on the *row* status rather than the
        // campaign's: a campaign cancelled without reverting still has live discounted
        // prices, and hiding those would be the expensive kind of tidy.
        expect(await newlyViolating(shopId)).toEqual([]);
      },
    );
  });
});
