/**
 * A bulk drift decision covers an edit detected in the millisecond before its page loaded
 * (#1134).
 *
 * The decision covers the events detected up to the page's `asOf` (#822). `asOf` is our clock
 * truncated to the millisecond, and `detectedAt` the database's `CURRENT_TIMESTAMP` rounded
 * to it: an event written in the same millisecond as the page, before it, could be stored a
 * millisecond past `asOf`, be shown on the page, and be left out of the decision. Seen as
 * "Putting back 2 prices" under three in `drift-bulk`, now and then.
 *
 * Pinned with stored times rather than raced for: one a millisecond past `asOf`, as the
 * rounding leaves it at most, and one two past, which no rounding explains.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { decideDrift } from "../../app/services/drift-queue.server";
import { chaosAdminClient } from "../harness/http-client";
import { withChaos } from "../harness/scenario";

describe("chaos: a drift event at the edge of the page's moment", () => {
  it("is in the decision when the rounding put it a millisecond past, and out when it is later than that", async () => {
    await withChaos("drift-asof-rounding", { catalog: { products: 2, variantsPerProduct: 1 }, percent: -20 }, async (chaos) => {
      const { shopId, campaignId, variantGids } = chaos.fixture;
      const [rounded, later] = variantGids;
      await prisma.campaign.update({ where: { id: campaignId }, data: { status: "HELD" } });

      const asOf = new Date(Date.parse("2026-10-29T09:00:00.462Z"));
      const edit = (variantGid: string, detectedAt: Date) =>
        prisma.driftEvent.create({
          data: { shopId, variantGid, surfaceKind: "BASE", campaignId, observedPrice: 123n, expectedPrice: 100n, currency: "USD", detectedAt },
        });
      const events = [await edit(rounded, new Date(asOf.getTime() + 1)), await edit(later, new Date(asOf.getTime() + 2))];

      const decided = await decideDrift(
        shopId,
        { campaignId, resolution: "ignore", asOf: asOf.toISOString() },
        "staff:1",
        chaosAdminClient(chaos.server.endpoint()),
      );
      expect(decided.ok, decided.message).toBe(true);

      const resolutions = await Promise.all(
        events.map(async (event) => (await prisma.driftEvent.findUniqueOrThrow({ where: { id: event.id } })).resolution),
      );
      expect(resolutions, "an edit stored a millisecond past the page was left out, or a later one was taken in").toEqual([
        "IGNORED",
        "PENDING",
      ]);
    });
  });
});
