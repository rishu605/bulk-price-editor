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
 * same rows, through the same writer (`writeCatalogRows`), so everything downstream is
 * unaffected by which ran -- including the rule that a page read before a campaign settled
 * its prices does not put the old ones back in the mirror (#1087).
 */

import { carryShopifyCosts } from "./baselines.server";
import { writeCatalogRows } from "./catalog-write.server";
import type { CatalogRow } from "../lib/catalog/bulk-jsonl";
import { variantDisplayTitle } from "../lib/catalog/variant-title";
import { parseMoney } from "../lib/money/money";
import { isTimeZone } from "../lib/scheduling/zone-shift";

/** Minimal client shape, so this is testable without an authenticated session. */
export interface GraphQLRunner {
  graphql(
    query: string,
    options?: { variables?: Record<string, unknown> },
  ): Promise<{ json(): Promise<unknown> }>;
}

/**
 * The rest of one product's variants.
 *
 * `variants(first: 100)` on the page query is not a limit anybody chose — it is the page
 * size — but for a product with 2,048 variants it silently dropped 1,948 of them. The app
 * would then manage a twentieth of that product and report a clean run over the part it
 * could see, which is the failure mode this whole product exists to prevent.
 *
 * 250 is the largest page Shopify allows on this connection, so a 2,048-variant product
 * costs eight follow-up requests and only products that need them pay anything.
 */
const PRODUCT_VARIANTS_PAGE = `#graphql
  query AnchorProductVariantsPage($id: ID!, $cursor: String) {
    product(id: $id) {
      featuredImage { url }
      variants(first: 250, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          title
          sku
          barcode
          price
          compareAtPrice
          inventoryQuantity
          image { url }
          inventoryItem { unitCost { amount currencyCode } }
        }
      }
    }
  }
`;

/**
 * The rest of one product's collections (#738).
 *
 * The page asks for twenty, and a product in a twenty-first was missing from every campaign
 * scoped to it -- on exactly the stores this path runs for, while the bulk path, which pages
 * nothing, got them all. Asked only for the products that need it, as their variants are.
 */
const PRODUCT_COLLECTIONS_PAGE = `#graphql
  query AnchorProductCollectionsPage($id: ID!, $cursor: String) {
    product(id: $id) {
      collections(first: 250, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { id }
      }
    }
  }
`;

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
        isGiftCard
        featuredImage { url }
        collections(first: 20) {
          pageInfo { hasNextPage endCursor }
          nodes { id }
        }
        variants(first: 100) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            title
            sku
            barcode
            price
            compareAtPrice
            inventoryQuantity
            image { url }
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
  isGiftCard?: boolean | null;
  featuredImage?: { url?: string | null } | null;
  collections?: {
    pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } | null;
    nodes?: Array<{ id: string }> | null;
  } | null;
  variants?: {
    pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } | null;
    nodes?: VariantNode[] | null;
  } | null;
}

interface VariantNode {
  id: string;
  title?: string | null;
  sku?: string | null;
  barcode?: string | null;
  price?: string | null;
  compareAtPrice?: string | null;
  inventoryQuantity?: number | null;
  image?: { url?: string | null } | null;
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
      if (product.collections?.pageInfo?.hasNextPage) {
        try {
          collections.push(...(await remainingCollections(client, product.id, product.collections.pageInfo.endCursor ?? null)));
        } catch (error) {
          // Recorded, as a missing variant page is: a product missing a collection is one a
          // campaign scoped to that collection silently leaves out.
          result.errors.push(
            `${product.id}: could not read past its first 20 collections — ` +
              `${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      // Everything the page gave us, then everything it did not. A product with more
      // variants than one page holds is rare and expensive to get wrong: those variants
      // are not merely missing from a report, they are variants no campaign can price.
      const variants = [...(product.variants?.nodes ?? [])];

      if (product.variants?.pageInfo?.hasNextPage) {
        try {
          variants.push(
            ...(await remainingVariants(client, product.id, product.variants.pageInfo.endCursor ?? null)),
          );
        } catch (error) {
          // Recorded, never swallowed: a product left partly mirrored is a product whose
          // campaigns will be partly applied, and the run has to be able to say so.
          result.errors.push(
            `${product.id}: could not read past the first page of variants — ` +
              `${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      // Read one at a time, so a price that does not parse costs that variant and not its
      // product; then written together.
      const rows: CatalogRow[] = [];
      for (const variant of variants) {
        try {
          rows.push(rowOf(product, variant, collections, shopCurrency));
        } catch (error) {
          result.errors.push(
            `${variant.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      try {
        await writeCatalogRows(shopId, shopCurrency, rows);
        result.variants += rows.length;
      } catch (error) {
        result.errors.push(
          `${product.id}: ${rows.length === 1 ? "its variant" : `its ${rows.length} variants`} could not be written — ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    hasNext = Boolean(page?.pageInfo?.hasNextPage);
    cursor = page?.pageInfo?.endCursor ?? null;

    // Defensive: a malformed page with hasNextPage true but no cursor would loop
    // forever, which on a background worker is worse than stopping short.
    if (hasNext && !cursor) break;
  }

  // Shopify's costs onto the current baselines, which the guardrails read (#737).
  await carryShopifyCosts(shopId);

  return result;
}

/**
 * Pages through a product's variants until they are all read.
 *
 * Bounded at forty pages — 10,000 variants, well past Shopify's 2,048 ceiling — so a
 * malformed cursor cannot spin a background worker forever. Hitting the bound is
 * reported by the caller rather than passing silently, for the same reason everything
 * else here is.
 */
async function remainingCollections(
  client: GraphQLRunner,
  productId: string,
  after: string | null,
): Promise<string[]> {
  const found: string[] = [];
  let cursor = after;

  // Bounded as the variants are: forty pages of 250 is more collections than a store has.
  for (let page = 0; page < 40; page += 1) {
    const response = await client.graphql(PRODUCT_COLLECTIONS_PAGE, { variables: { id: productId, cursor } });
    const body = (await response.json()) as {
      data?: {
        product?: {
          collections?: { pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }; nodes?: Array<{ id: string }> } | null;
        } | null;
      };
      errors?: Array<{ message: string }>;
    };
    if (body.errors?.length) throw new Error(body.errors.map((error) => error.message).join("; "));

    const connection = body.data?.product?.collections;
    found.push(...(connection?.nodes ?? []).map((node) => node.id));
    cursor = connection?.pageInfo?.endCursor ?? null;
    if (!connection?.pageInfo?.hasNextPage || !cursor) break;
  }

  return found;
}

async function remainingVariants(
  client: GraphQLRunner,
  productId: string,
  after: string | null,
): Promise<VariantNode[]> {
  const found: VariantNode[] = [];
  let cursor = after;

  for (let page = 0; page < 40; page += 1) {
    const response = await client.graphql(PRODUCT_VARIANTS_PAGE, {
      variables: { id: productId, cursor },
    });
    const body = (await response.json()) as {
      data?: {
        product?: {
          variants?: {
            pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
            nodes?: VariantNode[];
          } | null;
        } | null;
      };
      errors?: Array<{ message: string }>;
    };

    if (body.errors?.length) {
      throw new Error(body.errors.map((error) => error.message).join("; "));
    }

    const connection = body.data?.product?.variants;
    found.push(...(connection?.nodes ?? []));

    if (!connection?.pageInfo?.hasNextPage) return found;
    cursor = connection.pageInfo.endCursor ?? null;
    if (!cursor) return found;
  }

  throw new Error("stopped after 40 pages of variants");
}

/** One variant as the page read it, as the mirror holds it. Throws on a price that does not parse. */
function rowOf(
  product: ProductNode,
  variant: VariantNode,
  collections: string[],
  shopCurrency: string,
): CatalogRow {
  const unitCost = variant.inventoryItem?.unitCost;

  return {
    variantGid: variant.id,
    productGid: product.id,
    sku: variant.sku ?? null,
    barcode: variant.barcode ?? null,
    title: variantDisplayTitle(product.title, variant.title),
    // The variant's own image, falling back to the product's. A size that shares the
    // product photo is the common case, and showing nothing for it would make the
    // difference between "no photo" and "same photo as its siblings" invisible.
    imageUrl: variant.image?.url ?? product.featuredImage?.url ?? null,
    price: variant.price ? parseMoney(variant.price, shopCurrency) : null,
    compareAt: variant.compareAtPrice ? parseMoney(variant.compareAtPrice, shopCurrency) : null,
    cost: unitCost?.amount ? parseMoney(unitCost.amount, unitCost.currencyCode ?? shopCurrency) : null,
    inventoryQty: variant.inventoryQuantity ?? null,
    status: mapStatus(product.status),
    vendor: product.vendor ?? null,
    productType: product.productType ?? null,
    tags: product.tags ?? [],
    collections,
    isGiftCard: product.isGiftCard === true,
    remoteUpdatedAt: product.updatedAt ? new Date(product.updatedAt) : null,
  };
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
    shop {
      currencyCode
      ianaTimezone
      plan { partnerDevelopment }
    }
  }
`;

/**
 * Whether Shopify says this is a partner development store, or null when it did not say --
 * a failed query, a field missing. For the daily re-check (#713), which must not take a
 * development store's free tier away because one request failed.
 */
export async function fetchPartnerDevelopment(client: GraphQLRunner): Promise<boolean | null> {
  const body = (await (await client.graphql(SHOP_CURRENCY)).json()) as {
    data?: { shop?: { plan?: { partnerDevelopment?: boolean } | null } };
  };
  const flag = body.data?.shop?.plan?.partnerDevelopment;
  return typeof flag === "boolean" ? flag : null;
}

/**
 * The store's currency, or null when Shopify did not say (#1101). For a products webhook that
 * arrives before anything is mirrored, which used to guess US dollars.
 */
export async function fetchShopCurrency(client: GraphQLRunner): Promise<string | null> {
  const body = (await (await client.graphql(SHOP_CURRENCY)).json()) as { data?: { shop?: { currencyCode?: string } } };
  return body.data?.shop?.currencyCode ?? null;
}

export async function fetchShopBasics(
  client: GraphQLRunner,
): Promise<{ currency: string | null; timezone: string | null; developerStore: boolean }> {
  const response = await client.graphql(SHOP_CURRENCY);
  const body = (await response.json()) as {
    data?: {
      shop?: {
        currencyCode?: string;
        ianaTimezone?: string;
        plan?: { partnerDevelopment?: boolean } | null;
      };
    };
  };
  const zone = body.data?.shop?.ianaTimezone;
  return {
    // Null rather than "USD" when Shopify did not say (#1101): a guessed currency syncs a yen
    // store's ¥1,200 as $1,200.00. The sync stops on it instead.
    currency: body.data?.shop?.currencyCode ?? null,
    // Null rather than "UTC" when Shopify did not say (#799). A guessed zone is recorded as
    // if it were the store's, and every time typed against it is hours out.
    timezone: isTimeZone(zone) ? zone : null,
    // Defaults to false, so a query that fails or a field Shopify stops returning leaves
    // the shop on its real plan rather than silently handing out the top tier.
    developerStore: body.data?.shop?.plan?.partnerDevelopment === true,
  };
}
