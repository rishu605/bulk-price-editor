/**
 * Two presses of a scoped action make one writer (#1012).
 *
 * "Put it back" and "Revert this variant" ran under `…-${Date.now()}` keys, and the
 * one-live-run index skips scoped runs, so a double click or a resent request started two
 * writers for one variant -- rule 2, one writer per occurrence, broken by a button.
 *
 * Through the real `reassertDrift` and `revertVariant`, pressed twice at once.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { reassertDrift } from "../../app/services/campaigns/reassert.server";
import { revertVariant } from "../../app/services/campaigns/variant-revert.server";
import { isVariantWrite } from "../harness/faults";
import { chaosAdminClient } from "../harness/http-client";
import { withChaos } from "../harness/scenario";

const CATALOG = { catalog: { products: 2, variantsPerProduct: 1 }, percent: -30 } as const;

/** Writes the fake store received for one variant. */
const writesFor = (log: readonly unknown[], variantGid: string) =>
  log.filter((entry) => JSON.stringify(entry).includes(variantGid)).length;

describe("chaos: a scoped action pressed twice", () => {
  it("puts a drifted price back with one run, and a retry after a failure is still possible", async () => {
    await withChaos("pressed-once-reassert", CATALOG, async (chaos) => {
      const { shopId, campaignId, variantGids } = chaos.fixture;
      const [edited] = variantGids;
      const client = chaosAdminClient(chaos.server.endpoint());
      await chaos.expectHonest((await chaos.apply()).runId);
      const sale = chaos.fake.priceOf(edited)!;

      // The merchant's edit, recorded as drift on a held campaign.
      chaos.fake.variants.get(edited)!.price = "1.23";
      await prisma.priceSurfaceEntry.updateMany({ where: { shopId, variantGid: edited, surfaceKind: "BASE" }, data: { livePrice: 123n } });
      await prisma.campaign.update({ where: { id: campaignId }, data: { status: "HELD" } });
      const event = await prisma.driftEvent.create({
        data: { shopId, variantGid: edited, surfaceKind: "BASE", campaignId, observedPrice: 123n, expectedPrice: BigInt(Math.round(Number(sale) * 100)), currency: "USD" },
      });

      // A failed first attempt: Shopify refuses the write, so the event stays open.
      chaos.arm([{ fault: "server-error", match: (query) => isVariantWrite(query) }]);
      const failed = await reassertDrift(shopId, event.id, client, "staff:1");
      expect(failed.ok).toBe(false);
      chaos.heal();

      // Then two presses at once.
      const writesBefore = writesFor(chaos.fake.writeLog, edited);
      const [a, b] = await Promise.all([
        reassertDrift(shopId, event.id, client, "staff:1").catch((error: Error) => ({ ok: false, message: error.message })),
        reassertDrift(shopId, event.id, client, "staff:1").catch((error: Error) => ({ ok: false, message: error.message })),
      ]);
      expect([a.ok, b.ok].filter(Boolean), "both presses wrote, or neither did").toHaveLength(1);
      expect(chaos.fake.priceOf(edited)).toBe(sale);

      const runs = await prisma.campaignRun.findMany({
        where: { campaignId, occurrenceKey: { startsWith: `VARIANT-REASSERT-${event.id}` } },
        select: { occurrenceKey: true },
      });
      expect(runs.map((run) => run.occurrenceKey).sort(), "two presses made two writers").toEqual(
        [`VARIANT-REASSERT-${event.id}`, `VARIANT-REASSERT-${event.id}#2`].sort(),
      );
      expect(writesFor(chaos.fake.writeLog, edited) - writesBefore, "the variant was written twice").toBe(1);
    });
  });

  it("reverts one variant with one run when Revert this variant is pressed twice", async () => {
    await withChaos("pressed-once-revert", CATALOG, async (chaos) => {
      const { shopId, campaignId, variantGids, baseline } = chaos.fixture;
      const [variant] = variantGids;
      const client = chaosAdminClient(chaos.server.endpoint());
      await chaos.expectHonest((await chaos.apply()).runId);
      const writesBefore = writesFor(chaos.fake.writeLog, variant);

      await Promise.all([
        revertVariant(shopId, campaignId, variant, client, { actor: "staff:1" }),
        revertVariant(shopId, campaignId, variant, client, { actor: "staff:1" }),
      ]);
      expect(chaos.fake.priceOf(variant)).toBe((baseline.get(variant)! / 100).toFixed(2));
      expect(await prisma.campaignRun.count({ where: { campaignId, occurrenceKey: { startsWith: `VARIANT-REVERT-${variant}` } } })).toBe(1);
      expect(writesFor(chaos.fake.writeLog, variant) - writesBefore, "the variant was written twice").toBe(1);
    });
  });
});
