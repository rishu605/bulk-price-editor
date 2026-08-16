/**
 * Catalog mirror sync.
 *
 * Pulls products and variants into `variant_index` so filters, previews and planning
 * can run at store scale without hammering the Admin API. The mirror is a cache;
 * Shopify is truth, and the nightly sampled audit (P1.6) is what keeps that honest.
 *
 * This is the **paginated** path, which suits dev stores and small catalogues. The
 * bulk-query path (P1.1) is the one that matters at 500K variants, where the result
 * file has to be streamed rather than paged; that lands separately. Both write the
 * same rows, so everything downstream is unaffected by which ran.
 */

import prisma from "../db.server";
import { parseMoney } from "../lib/money/money";

/** Minimal client shape, so this is testable without an authenticated session. */
export interface GraphQLRunner {
  graphql(
    query: string,
    options?: { variables?: Record<string, unknown> },
  ): Promise<{ json(): Promise<unknown> }>;
}

const PRODUCTS_PAGE = `#graphql
  query AnchorCatalogPage($cursor: String) {
    products(first: 50, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        title
        vendor
        productType
        status
        tags
        updatedAt
        collections(first: 20) { nodes { id } }
        variants(first: 100) {
          nodes {
            id
            title
            sku
            barcode
            price
            compareAtPrice
            inventoryQuantity
            inventoryItem { unitCost { amount currencyCode } }
          }
        }
      }
    }
  }
`;

interface ProductNode {
  id: string;
  title: string;
  vendor?: string | null;
  productType?: string | null;
  status?: string | null;
  tags?: string[] | null;
  updatedAt?: string | null;
  collections?: { nodes?: Array<{ id: string }> | null } | null;
  variants?: { nodes?: VariantNode[] | null } | null;
}

interface VariantNode {
  id: string;
  title?: string | null;
  sku?: string | null;
  barcode?: string | null;
  price?: string | null;
  compareAtPrice?: string | null;
  inventoryQuantity?: number | null;
  inventoryItem?: { unitCost?: { amount?: string | null; currencyCode?: string | null } | null } | null;
}

export interface SyncResult {
  products: number;
  variants: number;
  pages: number;
  currency: string;
  errors: string[];
}

/**
 * Syncs the catalog into `variant_index`.
 *
 * Money is converted to integer minor units at the boundary, so nothing downstream
 * ever sees a decimal string or a float. A variant whose price fails to parse is
 * recorded as an error and skipped rather than stored as zero — a zero price that
 * looks real is far worse than a missing one.
 */
export async function syncCatalog(
  client: GraphQLRunner,
  shopId: string,
  shopCurrency: string,
): Promise<SyncResult> {
  const result: SyncResult = {
    products: 0,
    variants: 0,
    pages: 0,
    currency: shopCurrency,
    errors: [],
  };

  let cursor: string | null = null;
  let hasNext = true;

  while (hasNext) {
    const response = await client.graphql(PRODUCTS_PAGE, { variables: { cursor } });
    const body = (await response.json()) as {
      data?: { products?: { pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }; nodes?: ProductNode[] } };
      errors?: Array<{ message: string }>;
    };

    if (body.errors?.length) {
      result.errors.push(...body.errors.map((e) => e.message));
      break;
    }

    const page = body.data?.products;
    const nodes = page?.nodes ?? [];
    result.pages++;

    for (const product of nodes) {
      result.products++;
      const collections = product.collections?.nodes?.map((c) => c.id) ?? [];

      for (const variant of product.variants?.nodes ?? []) {
        try {
          await upsertVariant(shopId, product, variant, collections, shopCurrency);
          result.variants++;
        } catch (error) {
          result.errors.push(
            `${variant.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }

    hasNext = Boolean(page?.pageInfo?.hasNextPage);
    cursor = page?.pageInfo?.endCursor ?? null;

    // Defensive: a malformed page with hasNextPage true but no cursor would loop
    // forever, which on a background worker is worse than stopping short.
    if (hasNext && !cursor) break;
  }

  return result;
}

async function upsertVariant(
  shopId: string,
  product: ProductNode,
  variant: VariantNode,
  collections: string[],
  shopCurrency: string,
): Promise<void> {
  const price = variant.price ? parseMoney(variant.price, shopCurrency).amount : null;
  const compareAt = variant.compareAtPrice
    ? parseMoney(variant.compareAtPrice, shopCurrency).amount
    : null;

  const unitCost = variant.inventoryItem?.unitCost;
  const cost = unitCost?.amount
    ? parseMoney(unitCost.amount, unitCost.currencyCode ?? shopCurrency).amount
    : null;

  const data = {
    productGid: product.id,
    sku: variant.sku ?? null,
    barcode: variant.barcode ?? null,
    title: [product.title, variant.title].filter(Boolean).join(" · "),
    price: price === null ? null : BigInt(price),
    compareAt: compareAt === null ? null : BigInt(compareAt),
    cost: cost === null ? null : BigInt(cost),
    currency: shopCurrency,
    inventoryQty: variant.inventoryQuantity ?? null,
    status: mapStatus(product.status),
    vendor: product.vendor ?? null,
    productType: product.productType ?? null,
    tags: product.tags ?? [],
    collections,
    remoteUpdatedAt: product.updatedAt ? new Date(product.updatedAt) : null,
    syncedAt: new Date(),
    deletedAt: null,
  };

  await prisma.variantIndex.upsert({
    where: { shopId_variantGid: { shopId, variantGid: variant.id } },
    create: { shopId, variantGid: variant.id, ...data },
    update: data,
  });

  // Base-surface row, so the resolver and preview read every surface uniformly.
  await prisma.priceSurfaceEntry.upsert({
    where: {
      shopId_variantGid_surfaceKind_priceListGid: {
        shopId,
        variantGid: variant.id,
        surfaceKind: "BASE",
        priceListGid: "",
      },
    },
    create: {
      shopId,
      variantGid: variant.id,
      surfaceKind: "BASE",
      priceListGid: "",
      currency: shopCurrency,
      livePrice: data.price,
      liveCompareAt: data.compareAt,
    },
    update: { livePrice: data.price, liveCompareAt: data.compareAt, syncedAt: new Date() },
  });
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

const SHOP_CURRENCY = `#graphql
  query AnchorShopCurrency {
    shop { currencyCode ianaTimezone }
  }
`;

export async function fetchShopBasics(
  client: GraphQLRunner,
): Promise<{ currency: string; timezone: string }> {
  const response = await client.graphql(SHOP_CURRENCY);
  const body = (await response.json()) as {
    data?: { shop?: { currencyCode?: string; ianaTimezone?: string } };
  };
  return {
    currency: body.data?.shop?.currencyCode ?? "USD",
    timezone: body.data?.shop?.ianaTimezone ?? "UTC",
  };
}
