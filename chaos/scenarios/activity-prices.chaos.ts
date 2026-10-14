/**
 * A resolved drift, read back from the Activity log and its export (#757).
 *
 * On `dartmode-labs` a drift on The Minimal Snowboard -- $701.00 on the storefront -- was
 * logged as "variantGid: gid://shopify/ProductVariant/45725717004522, observedPrice: 70100".
 * The writer stored the bare minor units and the summariser printed what it found, so the
 * two halves agreed on nothing but a number. This drives the real writer (`resolveDrift`)
 * into the real reader (`activity`, as the page and the export call it), through Postgres,
 * in a two-decimal and a zero-decimal currency -- and reads an entry written the old way,
 * because those are already in merchants' logs.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { activityFiltersFrom } from "../../app/lib/reporting/export-filters";
import { activity, activityCsv } from "../../app/services/activity.server";
import { resolveDrift } from "../../app/services/drift.server";
import { withChaos } from "../harness/scenario";

const SNOWBOARD = "The Minimal Snowboard";

describe("chaos: prices in the Activity log", () => {
  it("shows a resolved drift's price in its currency, and the variant by title", async () => {
    await withChaos("activity-prices", { catalog: { products: 1, variantsPerProduct: 1 } }, async (chaos) => {
      const { shopId, variantGids } = chaos.fixture;
      const [variantGid] = variantGids;
      await prisma.auditLogEntry.deleteMany({ where: { shopId } });
      await prisma.variantIndex.update({
        where: { shopId_variantGid: { shopId, variantGid } },
        data: { title: SNOWBOARD },
      });

      const event = (observedPrice: bigint, currency: string) =>
        prisma.driftEvent.create({
          data: { shopId, variantGid, surfaceKind: "BASE", observedPrice, expectedPrice: 1n, currency },
        });
      const read = async () => {
        const { entries } = await activity(shopId, activityFiltersFrom(new URLSearchParams(), "UTC"));
        return entries;
      };

      // Two-decimal: the case in the issue.
      const dollars = await event(70100n, "USD");
      await resolveDrift(shopId, dollars.id, "ignore", "staff:42");
      // Zero-decimal: the same field read right by accident before, so the two looked alike.
      const yen = await event(701n, "JPY");
      await resolveDrift(shopId, yen.id, "ignore", "staff:42");

      const entries = await read();
      const summaryOf = (id: string) => entries.find((entry) => entry.entityId === id)?.summary;
      expect(summaryOf(dollars.id)).toBe(`variant: ${SNOWBOARD}, observedPrice: $701.00`);
      expect(summaryOf(yen.id)).toBe(`variant: ${SNOWBOARD}, observedPrice: ¥701`);

      // What the writer stored: the price with its currency, not a bare number.
      const stored = await prisma.auditLogEntry.findFirstOrThrow({ where: { shopId, entityId: dollars.id } });
      expect(stored.after).toEqual({ variantGid, observedPrice: { minor: "70100", currency: "USD" } });

      // The GID only in the export, in its own column; the page's summary has none.
      for (const entry of entries) expect(entry.summary).not.toContain("gid://");
      const csv = activityCsv(entries);
      const row = csv.split("\n").find((line) => line.includes(dollars.id))!;
      expect(row).toContain(`"variant: ${SNOWBOARD}, observedPrice: $701.00","${variantGid}"`);
    });
  });

  it("reads an entry written before prices carried their currency", async () => {
    await withChaos("activity-prices-legacy", { catalog: { products: 1, variantsPerProduct: 1 } }, async (chaos) => {
      const { shopId, variantGids } = chaos.fixture;
      const [variantGid] = variantGids;
      await prisma.auditLogEntry.deleteMany({ where: { shopId } });
      await prisma.variantIndex.update({
        where: { shopId_variantGid: { shopId, variantGid } },
        data: { title: SNOWBOARD },
      });

      // Exactly the issue's row: "Drift reassert", the minor units as a bare string. The
      // currency is not in the entry; it is on the event the entry names.
      const legacy = async (observedPrice: bigint, currency: string) => {
        const drift = await prisma.driftEvent.create({
          data: {
            shopId,
            variantGid,
            surfaceKind: "BASE",
            observedPrice,
            expectedPrice: 1n,
            currency,
            resolution: "REASSERTED",
          },
        });
        await prisma.auditLogEntry.create({
          data: {
            shopId,
            actor: "staff:42",
            action: "drift.reassert",
            entity: "DriftEvent",
            entityId: drift.id,
            after: { variantGid, observedPrice: String(observedPrice) },
          },
        });
        return drift.id;
      };
      const dollars = await legacy(70100n, "USD");
      const yen = await legacy(70100n, "JPY");

      // Not an entry about a drift event, so its bare number is left exactly as written:
      // the recovery reads the currency from the record the price came from, or not at all.
      await prisma.auditLogEntry.create({
        data: { shopId, action: "notification.drift", entity: "campaign", entityId: "c1", after: { pending: 70100 } },
      });

      const { entries } = await activity(shopId, activityFiltersFrom(new URLSearchParams(), "UTC"));
      const summaryOf = (id: string) => entries.find((entry) => entry.entityId === id)?.summary;
      expect(summaryOf(dollars)).toBe(`variant: ${SNOWBOARD}, observedPrice: $701.00`);
      expect(summaryOf(yen)).toBe(`variant: ${SNOWBOARD}, observedPrice: ¥70,100`);
      expect(summaryOf("c1")).toBe("pending: 70100");
    });
  });
});
