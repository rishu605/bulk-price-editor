/**
 * Product create / update / delete, keeping the catalog mirror current between syncs.
 *
 * Two rules govern everything here:
 *
 *   Deletes tombstone, never hard-delete. Ledger rows may still reference a variant
 *   that has since been deleted, and those rows must stay resolvable when a campaign
 *   reverts (edge case E4). Hard deletion turns a graceful skip into a foreign-key
 *   error mid-run.
 *
 *   Out-of-order deliveries are ignored, not applied. Shopify does not guarantee
 *   ordering, so an older payload arriving after a newer one would otherwise
 *   overwrite current data with stale data. `remoteUpdatedAt` decides.
 */

import type { ActionFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { parseMoney } from "../lib/money/money";
import { checkForDrift } from "../services/drift.server";

interface WebhookVariant {
  id: number | string;
  admin_graphql_api_id?: string;
  title?: string | null;
  sku?: string | null;
  barcode?: string | null;
  price?: string | null;
  compare_at_price?: string | null;
  inventory_quantity?: number | null;
}

interface WebhookProduct {
  id: number | string;
  admin_graphql_api_id?: string;
  title?: string;
  vendor?: string | null;
  product_type?: string | null;
  status?: string | null;
  tags?: string | string[] | null;
  updated_at?: string | null;
  variants?: WebhookVariant[];
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop: shopDomain, topic, payload } = await authenticate.webhook(request);

  const shop = await prisma.shop.findUnique({ where: { domain: shopDomain } });
  // A webhook for a shop we have never recorded is not an error: it can arrive
  // between install and first load. Acknowledge so Shopify does not retry.
  if (!shop) return new Response();

  const product = payload as unknown as WebhookProduct;
  const productGid =
    product.admin_graphql_api_id ?? `gid://shopify/Product/${product.id}`;

  if (topic === "PRODUCTS_DELETE") {
    await prisma.variantIndex.updateMany({
      where: { shopId: shop.id, productGid },
      data: { deletedAt: new Date() },
    });
    return new Response();
  }

  const remoteUpdatedAt = product.updated_at ? new Date(product.updated_at) : null;
  const currency = await currencyFor(shop.id);

  const tags = Array.isArray(product.tags)
    ? product.tags
    : typeof product.tags === "string"
      ? product.tags.split(",").map((t) => t.trim()).filter(Boolean)
      : [];

  for (const variant of product.variants ?? []) {
    const variantGid =
      variant.admin_graphql_api_id ?? `gid://shopify/ProductVariant/${variant.id}`;

    const existing = await prisma.variantIndex.findUnique({
      where: { shopId_variantGid: { shopId: shop.id, variantGid } },
      select: { remoteUpdatedAt: true },
    });

    // Stale delivery: we already hold something newer.
    if (
      existing?.remoteUpdatedAt &&
      remoteUpdatedAt &&
      existing.remoteUpdatedAt > remoteUpdatedAt
    ) {
      continue;
    }

    const price = safeMinor(variant.price, currency);
    const compareAt = safeMinor(variant.compare_at_price, currency);

    const data = {
      productGid,
      sku: variant.sku ?? null,
      barcode: variant.barcode ?? null,
      title: [product.title, variant.title].filter(Boolean).join(" · "),
      price,
      compareAt,
      currency,
      inventoryQty: variant.inventory_quantity ?? null,
      status: mapStatus(product.status),
      vendor: product.vendor ?? null,
      productType: product.product_type ?? null,
      tags,
      remoteUpdatedAt,
      syncedAt: new Date(),
      // A variant reappearing after deletion clears its tombstone.
      deletedAt: null,
    };

    // Before overwriting the mirror, ask whether this change was ours. A price that
    // moved under an active campaign and is not our echo is a merchant edit, and
    // silently adopting it would hide exactly what they need to know about.
    await checkForDrift(shop.id, variantGid, price, compareAt);

    await prisma.variantIndex.upsert({
      where: { shopId_variantGid: { shopId: shop.id, variantGid } },
      create: { shopId: shop.id, variantGid, ...data },
      update: data,
    });

    await prisma.priceSurfaceEntry.upsert({
      where: {
        shopId_variantGid_surfaceKind_priceListGid: {
          shopId: shop.id,
          variantGid,
          surfaceKind: "BASE",
          priceListGid: "",
        },
      },
      create: {
        shopId: shop.id,
        variantGid,
        surfaceKind: "BASE",
        priceListGid: "",
        currency,
        livePrice: price,
        liveCompareAt: compareAt,
      },
      update: { livePrice: price, liveCompareAt: compareAt, syncedAt: new Date() },
    });
  }

  return new Response();
};

/**
 * Parses a price to minor units, returning null rather than throwing.
 *
 * A webhook is not a good place to fail loudly on one odd value: rejecting the
 * response makes Shopify retry the whole payload forever. Null means "unknown",
 * which the planner already treats as a reason to write rather than to skip.
 */
function safeMinor(value: string | null | undefined, currency: string): bigint | null {
  if (!value) return null;
  try {
    return BigInt(parseMoney(value, currency).amount);
  } catch {
    return null;
  }
}

async function currencyFor(shopId: string): Promise<string> {
  const row = await prisma.variantIndex.findFirst({
    where: { shopId, currency: { not: null } },
    select: { currency: true },
  });
  return row?.currency ?? "USD";
}

function mapStatus(status?: string | null): "ACTIVE" | "ARCHIVED" | "DRAFT" {
  switch ((status ?? "").toUpperCase()) {
    case "ARCHIVED":
      return "ARCHIVED";
    case "DRAFT":
      return "DRAFT";
    default:
      return "ACTIVE";
  }
}
