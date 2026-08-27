/**
 * A revert must not be defeated by a mirror that says the wrong thing.
 *
 * Observed on a real store: a campaign applied, one row failed read-back, and the revert
 * that followed reported `clean: true` with `verified: 0`, wrote nothing, and moved the
 * campaign to COMPLETED — while the storefront kept the sale price. The campaign said it
 * was over and the merchant was still discounted, which is the failure this product
 * exists to prevent.
 *
 * The chain:
 *
 *   `refreshMirror` skipped failed rows, so the mirror kept the *pre-run* price. That
 *   reads like caution — do not record what you could not verify — but the effect is the
 *   opposite: the mirror goes on making a definite claim, and the claim is wrong.
 *
 *   `planRun` believes it. `isNoop` compares the revert's target against that stale live
 *   price, finds them equal, and drops the row before it is ever written.
 *
 * So the revert had nothing to do. Null is the honest value, and `isNoop` already refuses
 * to treat an absent live price as already-correct.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { planRun } from "../../app/lib/planning/plan";
import { withChaos } from "../harness/scenario";

describe("chaos: reverting after a row failed read-back", () => {
  it("still plans a write for the row whose live price is unknown", async () => {
    await withChaos(
      "revert-after-failed-row",
      { catalog: { products: 3, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const shopId = chaos.fixture.shopId;
        const variantGid = chaos.fixture.variantGids[0]!;
        const baseline = chaos.fixture.baseline.get(variantGid)!;

        // The state a failed row used to leave behind: the mirror still asserting the
        // price from before the run, while Shopify holds the sale price.
        await prisma.priceSurfaceEntry.updateMany({
          where: { shopId, variantGid, surfaceKind: "BASE", priceListGid: "" },
          data: { livePrice: BigInt(baseline) },
        });

        const stale = await plannedFor(shopId, variantGid, baseline);
        expect(
          stale,
          "a mirror asserting the pre-run price makes the revert look like a no-op",
        ).toBe(false);

        // What the fix records instead: we do not know what is live.
        await prisma.priceSurfaceEntry.updateMany({
          where: { shopId, variantGid, surfaceKind: "BASE", priceListGid: "" },
          data: { livePrice: null },
        });

        const unknown = await plannedFor(shopId, variantGid, baseline);
        expect(
          unknown,
          "an unknown live price must be written, not assumed already correct",
        ).toBe(true);
      },
    );
  });

  it("leaves the mirror saying unknown after a real read-back failure", async () => {
    await withChaos(
      "revert-after-failed-row-live",
      { catalog: { products: 3, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const shopId = chaos.fixture.shopId;
        const variantGid = chaos.fixture.variantGids[0]!;

        const before = await prisma.priceSurfaceEntry.findFirstOrThrow({
          where: { shopId, variantGid, surfaceKind: "BASE", priceListGid: "" },
          select: { livePrice: true },
        });
        expect(before.livePrice, "the fixture starts with a known live price").not.toBeNull();

        // Shopify stores something other than what we asked for, on this variant only.
        // That is a read-back failure for real rather than a hand-written ledger row.
        chaos.fake.distortStoredPrice = (requested, gid) =>
          gid === variantGid ? String(Number(requested) + 1) : requested;

        // The harness's own apply, so this goes through the real run path.
        const outcome = await chaos.apply();
        expect(outcome.clean, "a distorted row must not report clean").toBe(false);

        const row = await prisma.variantChange.findFirstOrThrow({
          where: { shopId, variantGid, surfaceKind: "BASE" },
          orderBy: { createdAt: "desc" },
          select: { status: true },
        });
        expect(row.status, "the distorted row is the one that failed").toBe("FAILED");

        const after = await prisma.priceSurfaceEntry.findFirstOrThrow({
          where: { shopId, variantGid, surfaceKind: "BASE", priceListGid: "" },
          select: { livePrice: true },
        });
        expect(
          after.livePrice,
          "read-back failed, so the mirror must say unknown rather than the old price",
        ).toBeNull();

        const index = await prisma.variantIndex.findFirstOrThrow({
          where: { shopId, variantGid },
          select: { price: true },
        });
        expect(index.price, "both copies of the live price say unknown").toBeNull();
      },
    );
  });
});

/**
 * Whether a revert — resolving with no campaign at all — would write this variant.
 *
 * Reverting is `resolve(without C)`, and with a single campaign that leaves nothing, so
 * the target is the baseline. Passing no campaigns models exactly that.
 */
async function plannedFor(
  shopId: string,
  variantGid: string,
  baseline: number,
): Promise<boolean> {
  const { loadCandidates } = await import("../../app/services/campaigns/candidates.server");
  const candidates = await loadCandidates(shopId, { groups: [] }, [variantGid], []);

  const outcome = planRun({ campaigns: [], candidates, storeGuardrails: {} });
  if (outcome.kind !== "ok") throw new Error(`planning was ${outcome.kind}`);

  const row = outcome.rows.find((r) => r.ref.variantGid === variantGid);
  // A row that is absent was dropped as a no-op; a skipped one was declined for a reason.
  if (!row || row.status === "skipped") return false;

  expect(row.intendedPrice?.amount, "a revert targets the baseline").toBe(baseline);
  return true;
}
