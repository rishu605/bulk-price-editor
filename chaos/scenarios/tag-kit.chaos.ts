/**
 * Storefront tags, and the promise that they come off again.
 *
 * The tag kit is the app's entire storefront integration — a theme badges sale items
 * by keying off a tag, and no theme code ships. That trade only holds if the tags are
 * removed as reliably as the prices are, because the failure is uniquely visible:
 * "SALE" on a full-price product, weeks after the sale ended, with the app insisting
 * the campaign is over.
 *
 * Two claims, and the second is the one that could lose a merchant real merchandising:
 *
 *   A revert removes every tag the campaign added, across all of its runs — including
 *   on products that joined after it started.
 *
 *   A revert never removes a tag the merchant put there. A campaign asking for "SALE"
 *   on a product already tagged "SALE" adds nothing, so it owns nothing, and taking it
 *   back would be deleting somebody else's work.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { withChaos } from "../harness/scenario";

const has = (tags: string[], tag: string) =>
  tags.some((t) => t.toLowerCase() === tag.toLowerCase());

describe("chaos: the campaign tag kit", () => {
  it("tags on apply, removes on revert, and never touches a merchant's own tag", async () => {
    await withChaos(
      "tag-kit",
      { catalog: { products: 6, variantsPerProduct: 2 }, percent: -20, tagKit: ["SALE", "SUMMER"] },
      async (chaos) => {
        const productGids = [...new Set([...chaos.fixture.productOf.values()])];

        // One product the merchant had already tagged SALE, in a different case, for
        // their own reasons. The campaign must add SUMMER to it and leave SALE alone.
        const preTagged = productGids[0];
        chaos.fake.addMerchantTag(preTagged, "sale");

        // ------------------------------------------------------------ apply
        const applied = await chaos.apply();
        await chaos.expectHonest(applied.runId);

        for (const productGid of productGids) {
          const tags = chaos.fake.tagsOf(productGid);
          expect(has(tags, "SALE")).toBe(true);
          expect(has(tags, "SUMMER")).toBe(true);
        }

        // The ledger knows which tags are the app's. On the pre-tagged product only
        // SUMMER is claimed; SALE is recorded as the merchant's.
        const claimed = await prisma.tagChange.findFirst({
          where: { runId: applied.runId, productGid: preTagged },
        });
        expect(claimed?.addedTags).toEqual(["SUMMER"]);
        expect(claimed?.alreadyPresent).toEqual(["SALE"]);
        expect(claimed?.status).toBe("VERIFIED");

        // ----------------------------------------------------------- revert
        await chaos.revert();

        for (const productGid of productGids.slice(1)) {
          const tags = chaos.fake.tagsOf(productGid);
          expect(has(tags, "SALE")).toBe(false);
          expect(has(tags, "SUMMER")).toBe(false);
        }

        // The claim that matters. The merchant's own SALE survives; only SUMMER,
        // which the app genuinely added, is gone.
        const survivors = chaos.fake.tagsOf(preTagged);
        expect(has(survivors, "SALE")).toBe(true);
        expect(has(survivors, "SUMMER")).toBe(false);
      },
    );
  });

  it("removes tags from products that joined after the campaign started", async () => {
    await withChaos(
      "tag-kit-enrolled",
      { catalog: { products: 4, variantsPerProduct: 1 }, percent: -15, tagKit: ["SALE"] },
      async (chaos) => {
        const { shopId, variantGids, productOf } = chaos.fixture;

        const first = await chaos.apply();
        await chaos.expectHonest(first.runId);

        // A product that enters scope mid-campaign: tagged in the catalogue and
        // mirrored, exactly as auto-enroll leaves it before the next run.
        const latecomerVariant = "gid://shopify/ProductVariant/latecomer";
        const latecomerProduct = "gid://shopify/Product/latecomer";
        chaos.fake.addVariant({
          variantGid: latecomerVariant,
          productGid: latecomerProduct,
          price: "50.00",
          compareAtPrice: null,
        });
        await prisma.variantIndex.create({
          data: {
            shopId,
            variantGid: latecomerVariant,
            productGid: latecomerProduct,
            title: "Latecomer",
            price: BigInt(5_000),
            currency: "USD",
            status: "ACTIVE",
            tags: ["chaos"],
          },
        });
        await prisma.priceSurfaceEntry.create({
          data: {
            shopId,
            variantGid: latecomerVariant,
            surfaceKind: "BASE",
            priceListGid: "",
            currency: "USD",
            livePrice: BigInt(5_000),
          },
        });
        await prisma.baseline.create({
          data: {
            shopId,
            variantGid: latecomerVariant,
            surfaceKind: "BASE",
            priceListGid: "",
            currency: "USD",
            basePrice: BigInt(5_000),
            source: "AUTO_ENROLL",
          },
        });

        // The re-apply that auto-enroll triggers.
        const second = await chaos.apply();
        await chaos.expectHonest(second.runId);
        expect(has(chaos.fake.tagsOf(latecomerProduct), "SALE")).toBe(true);

        // Reverting must clear the latecomer too. Taking only the newest run's ledger
        // rows would strand the original products' badges instead.
        await chaos.revert();

        expect(has(chaos.fake.tagsOf(latecomerProduct), "SALE")).toBe(false);
        for (const gid of variantGids) {
          expect(has(chaos.fake.tagsOf(productOf.get(gid)!), "SALE")).toBe(false);
        }
      },
    );
  });
});
