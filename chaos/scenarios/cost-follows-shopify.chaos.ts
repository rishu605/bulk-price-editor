/**
 * A cost raised in Shopify reaches the guardrail, and the cost import compares with the cost
 * the guardrail uses (#737).
 *
 * The guardrails read `baseline.cost ?? variant.cost`; the catalogue sync updated only the
 * mirror's. So, the ticket's four steps:
 *
 *   1. a baseline captured with cost $5;
 *   2. the cost raised to $8 in Shopify, and a sync: the mirror read 800, the baseline 500;
 *   3. the merchant imports "SKU,8.00" to make sure, and it said "already matched";
 *   4. "never below cost" still floored at $5, so a $7 sale price was allowed.
 *
 * The sync is the real `syncCatalog` against a store serving one product.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { money } from "../../app/lib/money/money";
import { createCampaign } from "../../app/services/campaigns/model.server";
import { previewCampaign } from "../../app/services/campaigns/preview.server";
import { importCosts } from "../../app/services/cost-import.server";
import { DEFAULT_SETTINGS, writeSettings } from "../../app/services/settings.server";
import { withChaos } from "../harness/scenario";

const PRODUCT = "gid://shopify/Product/cost-follows";
const VARIANT = "gid://shopify/ProductVariant/cost-follows-1";

/** A store with one product, one variant at $10 whose Shopify cost is `cost`. */
function storeCosting(cost: string | null) {
  return {
    async graphql() {
      return {
        json: async () => ({
          data: {
            products: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  id: PRODUCT,
                  title: "Cost follows",
                  vendor: "Anchor",
                  productType: "Test",
                  status: "ACTIVE",
                  tags: [],
                  updatedAt: new Date().toISOString(),
                  collections: { nodes: [] },
                  variants: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [
                      {
                        id: VARIANT,
                        title: "One",
                        sku: "COST-FOLLOWS",
                        barcode: null,
                        price: "10.00",
                        compareAtPrice: null,
                        inventoryQuantity: 5,
                        inventoryItem: { unitCost: cost ? { amount: cost, currencyCode: "USD" } : null },
                      },
                    ],
                  },
                },
              ],
            },
          },
        }),
      };
    },
  };
}

async function* lines(text: string) {
  for (const line of text.split("\n")) yield line;
}

describe("chaos: a cost changed in Shopify", () => {
  it("reaches the baseline the guardrail reads, and a re-import of it is unchanged", async () => {
    await withChaos("cost-follows-shopify", { catalog: { products: 1, variantsPerProduct: 1 } }, async (chaos) => {
      const { shopId } = chaos.fixture;
      const { syncCatalog } = await import("../../app/services/catalog-sync.server");
      const { captureBaselines } = await import("../../app/services/baselines.server");
      const current = () =>
        prisma.baseline.findFirstOrThrow({ where: { shopId, variantGid: VARIANT, surfaceKind: "BASE", supersededAt: null } });

      // 1. Captured with cost $5.
      await syncCatalog(storeCosting("5.00") as never, shopId, "USD");
      await captureBaselines(shopId, { variantGids: [VARIANT], source: "INSTALL_CAPTURE" });
      expect((await current()).cost).toBe(500n);

      // 2. Raised to $8 in Shopify, and a sync.
      await syncCatalog(storeCosting("8.00") as never, shopId, "USD");
      expect((await prisma.variantIndex.findFirstOrThrow({ where: { shopId, variantGid: VARIANT } })).cost).toBe(800n);
      expect((await current()).cost, "the baseline the guardrail reads kept the old cost").toBe(800n);

      // 3. The merchant imports the same $8: already matched, and true.
      const reimport = await importCosts(shopId, lines("Variant SKU,Variant Cost\nCOST-FOLLOWS,8.00"), "USD");
      expect(reimport).toMatchObject({ unchanged: 1, ready: 0 });

      // 4. "Never below cost" floors a $7 sale at the $8 Shopify now has, not the $5 it had.
      await writeSettings(shopId, { ...DEFAULT_SETTINGS, neverBelowCost: true });
      const sale = await createCampaign(shopId, {
        name: "chaos/cost-follows $7",
        rule: { kind: "set-exact", amount: money(700, "USD") },
        compareAtPolicy: { kind: "leave" },
        rounding: { default: "none", byCurrency: {} },
        ast: { groups: [] },
        schedule: { kind: "manual" },
      });
      const row = (await previewCampaign(shopId, sale.id)).rows.find((r) => r.variantGid === VARIANT);
      expect(row?.after, "the guardrail floored at the old cost").toBe("8.00");

      // A cost Shopify does not hold is never copied over an imported one.
      await importCosts(shopId, lines("Variant SKU,Variant Cost\nCOST-FOLLOWS,9.00"), "USD");
      await syncCatalog(storeCosting(null) as never, shopId, "USD");
      expect((await current()).cost, "an empty Shopify cost wiped the imported one").toBe(900n);
    });
  });

  it("compares a re-import with the baseline's cost, not only the mirror's", async () => {
    await withChaos("cost-import-compares-baseline", { catalog: { products: 1, variantsPerProduct: 1 } }, async (chaos) => {
      const { shopId, variantGids } = chaos.fixture;
      const variantGid = variantGids[0];
      await prisma.variantIndex.updateMany({ where: { shopId, variantGid }, data: { sku: "COST-CMP", cost: 800n } });
      await prisma.baseline.updateMany({ where: { shopId, variantGid, supersededAt: null }, data: { cost: 500n } });

      // The mirror says 8.00 and the baseline -- what "never below cost" reads -- says 5.00.
      const result = await importCosts(shopId, lines("Variant SKU,Variant Cost\nCOST-CMP,8.00"), "USD");
      expect(result, "the import called a stale guardrail cost already matched").toMatchObject({ ready: 1, unchanged: 0 });
      const baseline = await prisma.baseline.findFirstOrThrow({ where: { shopId, variantGid, supersededAt: null } });
      expect(baseline.cost).toBe(800n);
    });
  });
});
