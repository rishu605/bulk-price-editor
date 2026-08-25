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
});
