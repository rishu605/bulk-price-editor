/**
 * The nightly check that keeps "the mirror is a cache, Shopify is truth" honest.
 *
 * Webhooks get missed, payloads arrive out of order, bugs slip in. Without an
 * independent check, mirror drift is invisible until a campaign prices the wrong
 * products — and by then there is no recovering the trust, because "the app changed
 * prices it should not have" is not something you explain your way out of.
 *
 * The ticket asks for injected divergence to be detected and healed. That is exactly
 * what this does: the store is changed behind the app's back, the way a missed webhook
 * leaves it, and the audit has to notice without being told.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { formatMoney, money } from "../../app/lib/money/money";
import { auditMirror } from "../../app/services/mirror-audit.server";
import { chaosAdminClient } from "../harness/http-client";
import { withChaos } from "../harness/scenario";

describe("chaos: the nightly mirror audit", () => {
  it("finds injected divergence, heals it, and says nothing was wrong when nothing was", async () => {
    await withChaos(
      "mirror-audit",
      { catalog: { products: 6, variantsPerProduct: 2 }, percent: -10 },
      async (chaos) => {
        const { shopId, variantGids } = chaos.fixture;
        const client = chaosAdminClient(chaos.server.endpoint());

        // A mirror that matches reality reports so. Anything else and the audit is
        // crying wolf every night, which is how a real alert gets ignored.
        const clean = await auditMirror(client, shopId);
        expect(clean.checked).toBe(variantGids.length);
        expect(clean.diverged).toBe(0);
        expect(clean.alert).toBe(false);

        // ------------------------------------------------- inject divergence
        // Changed in Shopify only. This is what a missed `products/update` webhook
        // leaves behind: the store moved and the app has no idea.
        const drifted = variantGids[0];
        chaos.fake.variants.get(drifted)!.price = "3.21";

        // And one the merchant deleted without us hearing about it.
        const vanished = variantGids[1];
        chaos.fake.deleteVariant(vanished);

        const audit = await auditMirror(client, shopId);

        expect(audit.diverged).toBe(2);
        // "deleted" rather than "unknown-to-shopify": Shopify answers a null node for
        // an id it no longer knows, which is a definite answer. The other kind is the
        // defensive case where a response omits an id altogether.
        expect(audit.divergences.map((d) => d.kind).sort()).toEqual(["deleted", "price"]);

        // ---------------------------------------------------------- healed
        // The point is a mirror that is right afterwards, not a report saying it was
        // wrong.
        const healed = await prisma.variantIndex.findUniqueOrThrow({
          where: { shopId_variantGid: { shopId, variantGid: drifted } },
        });
        expect(healed.price).toBe(321n);

        const surface = await prisma.priceSurfaceEntry.findFirstOrThrow({
          where: { shopId, variantGid: drifted, surfaceKind: "BASE", priceListGid: "" },
        });
        expect(surface.livePrice).toBe(321n);

        // Tombstoned, never deleted: ledger rows still reference it and have to stay
        // resolvable on revert (E4).
        const gone = await prisma.variantIndex.findUniqueOrThrow({
          where: { shopId_variantGid: { shopId, variantGid: vanished } },
        });
        expect(gone.deletedAt).not.toBeNull();
        expect(audit.tombstoned).toBe(1);

        // -------------------------------------------------- and it stays healed
        // A second pass finds nothing, which is the only way to know the healing was
        // real rather than the audit forgetting.
        const after = await auditMirror(client, shopId);
        expect(after.diverged).toBe(0);
        // The tombstoned variant is out of the sample now, so one fewer is checked.
        expect(after.checked).toBe(variantGids.length - 1);

        // Recorded on the quiet nights too. A rate that is fine tonight and creeping
        // next week is the signal worth having, and it only exists if the clean runs
        // are written down.
        const entries = await prisma.auditLogEntry.count({
          where: { shopId, action: "mirror.audit" },
        });
        expect(entries).toBe(3);
      },
    );
  });

  it("alerts when divergence is systematic rather than incidental", async () => {
    await withChaos(
      "mirror-audit-alert",
      { catalog: { products: 10, variantsPerProduct: 2 }, percent: -10 },
      async (chaos) => {
        const { shopId, variantGids } = chaos.fixture;
        const client = chaosAdminClient(chaos.server.endpoint());

        // A quarter of the catalogue moved. One missed webhook is a row; this is a
        // pipeline, and the response is a re-sync rather than more healing.
        for (const gid of variantGids.slice(0, 5)) {
          chaos.fake.variants.get(gid)!.price = "1.11";
        }

        const audit = await auditMirror(client, shopId);

        expect(audit.diverged).toBe(5);
        expect(audit.rate).toBeGreaterThan(0.005);
        expect(audit.alert).toBe(true);
        expect(audit.healed).toBe(5);
      },
    );
  });

  it("finds variants that are mirrored but impossible to price, and rebuilds them", async () => {
    /**
     * The other way the mirror can be wrong, and the one every other check here misses.
     *
     * Everything above compares us against Shopify. This compares us against ourselves.
     * `variant_index` and `price_surface_entries` are written together by six code paths,
     * and nothing checked that they agreed — so when the bulk import stopped writing the
     * second one, a whole catalogue was mirrored, counted and displayed, and could not be
     * priced, because baselines are captured from the surface table.
     *
     * The nightly audit reported all clear, and it was right to: the mirror agreed with
     * Shopify perfectly. The disagreement was between our own two tables, and nobody was
     * looking there.
     */
    await withChaos(
      "mirror-audit-unpriceable",
      { catalog: { products: 4, variantsPerProduct: 2 }, percent: -10 },
      async (chaos) => {
        const { shopId, variantGids } = chaos.fixture;
        const client = chaosAdminClient(chaos.server.endpoint());

        const healthy = await auditMirror(client, shopId);
        expect(healthy.unpriceable).toBe(0);

        // What a broken import path leaves behind: the index row is there, the surface
        // row is not. Nothing about the store has changed, so no amount of comparing
        // against Shopify would ever notice.
        const orphaned = variantGids[0];
        await prisma.priceSurfaceEntry.deleteMany({
          where: { shopId, variantGid: orphaned, surfaceKind: "BASE", priceListGid: "" },
        });

        const found = await auditMirror(client, shopId);

        expect(found.unpriceable).toBe(1);
        expect(found.unpriceableHealed).toBe(1);

        // Rebuilt from the index row, which already held the price — re-reading Shopify
        // for something we know would spend budget to learn nothing.
        const index = await prisma.variantIndex.findUniqueOrThrow({
          where: { shopId_variantGid: { shopId, variantGid: orphaned } },
        });
        const rebuilt = await prisma.priceSurfaceEntry.findUniqueOrThrow({
          where: {
            shopId_variantGid_surfaceKind_priceListGid: {
              shopId, variantGid: orphaned, surfaceKind: "BASE", priceListGid: "",
            },
          },
        });
        expect(rebuilt.livePrice).toBe(index.price);

        // And it stays fixed rather than being rebuilt every night.
        const after = await auditMirror(client, shopId);
        expect(after.unpriceable).toBe(0);
      },
    );
  });

  it("does not claim to have healed a variant it cannot heal", async () => {
    /**
     * A surface row with a null price clears the symptom and leaves the variant exactly
     * as unpriceable, one table further along — `captureBaselines` would capture nothing
     * from it. So a variant whose index row has no price is counted and not healed, and
     * the caller alerts on the difference.
     *
     * Shopify has no price for it either, which is what makes this the unhealable case
     * rather than a repairable one. With a price in Shopify the audit would simply fix
     * the index row and the rebuild would then succeed — that is the ordinary path, and
     * it is why this test sets both sides to nothing. There is no price to be had.
     */
    await withChaos(
      "mirror-audit-unhealable",
      { catalog: { products: 4, variantsPerProduct: 2 }, percent: -10 },
      async (chaos) => {
        const { shopId, variantGids } = chaos.fixture;
        const client = chaosAdminClient(chaos.server.endpoint());

        const orphaned = variantGids[variantGids.length - 1];
        await prisma.priceSurfaceEntry.deleteMany({
          where: { shopId, variantGid: orphaned, surfaceKind: "BASE", priceListGid: "" },
        });
        await prisma.variantIndex.updateMany({
          where: { shopId, variantGid: orphaned },
          data: { price: null },
        });
        // Priceless on both sides, so the sample agrees with the mirror and the repair
        // path has nothing to repair. Without this the outcome would depend on whether
        // the random sample happened to draw this row.
        chaos.fake.variants.get(orphaned)!.price = "";

        const result = await auditMirror(client, shopId);

        expect(result.unpriceable).toBe(1);
        // Not healed, and not pretended to be. The alert is on the difference.
        expect(result.unpriceableHealed).toBe(0);

        const still = await prisma.priceSurfaceEntry.findFirst({
          where: { shopId, variantGid: orphaned, surfaceKind: "BASE", priceListGid: "" },
        });
        expect(still, "wrote a surface row with no price to clear the symptom").toBeNull();
      },
    );
  });

  it.each(["JPY", "KWD"])(
    "leaves a correct %s mirror alone instead of healing it by a factor of 100 (#693)",
    async (currency) => {
      await withChaos(
        `mirror-audit-${currency.toLowerCase()}`,
        { catalog: { products: 3, variantsPerProduct: 1, currency }, percent: -10 },
        async (chaos) => {
          const { shopId, variantGids } = chaos.fixture;
          const client = chaosAdminClient(chaos.server.endpoint());

          // Shopify answers in the shop's currency, in that currency's own decimals:
          // ¥1,980 is "1980.0", 12.500 KWD is "12.500". The mirror already holds the
          // right minor units; the fixture's two-decimal strings are replaced to match.
          chaos.fake.shopCurrency = currency;
          const mirrored = new Map<string, bigint>();
          for (const gid of variantGids) {
            const row = await prisma.variantIndex.findUniqueOrThrow({
              where: { shopId_variantGid: { shopId, variantGid: gid } },
            });
            mirrored.set(gid, row.price!);
            chaos.fake.variants.get(gid)!.price = formatMoney(money(Number(row.price), currency));
          }

          const audit = await auditMirror(client, shopId);

          expect(audit.checked).toBe(variantGids.length);
          expect(
            audit.diverged,
            JSON.stringify(audit.divergences, (_, v) => (typeof v === "bigint" ? String(v) : v)),
          ).toBe(0);
          expect(audit.healed).toBe(0);
          expect(audit.alert).toBe(false);

          // And the mirror is exactly what it was: nothing rewritten a hundredfold.
          for (const gid of variantGids) {
            const row = await prisma.variantIndex.findUniqueOrThrow({
              where: { shopId_variantGid: { shopId, variantGid: gid } },
            });
            expect(row.price).toBe(mirrored.get(gid));
          }
        },
      );
    },
  );

  it("does not heal a price it cannot read, and does not tombstone it either", async () => {
    await withChaos(
      "mirror-audit-unreadable",
      { catalog: { products: 2, variantsPerProduct: 1 }, percent: -10 },
      async (chaos) => {
        const { shopId, variantGids } = chaos.fixture;
        const before = await prisma.variantIndex.findUniqueOrThrow({
          where: { shopId_variantGid: { shopId, variantGid: variantGids[0] } },
        });

        // Three decimals in a two-decimal currency: not a price in USD at all.
        chaos.fake.variants.get(variantGids[0])!.price = "19.999";
        const audit = await auditMirror(chaosAdminClient(chaos.server.endpoint()), shopId);

        expect(audit.checked).toBe(variantGids.length - 1);
        expect(audit.healed).toBe(0);
        expect(audit.tombstoned).toBe(0);
        const after = await prisma.variantIndex.findUniqueOrThrow({
          where: { shopId_variantGid: { shopId, variantGid: variantGids[0] } },
        });
        expect(after.price).toBe(before.price);
        expect(after.deletedAt).toBeNull();
      },
    );
  });
});
