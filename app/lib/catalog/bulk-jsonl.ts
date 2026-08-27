/**
 * Reassembling a bulk-query result file into catalogue rows, as a stream.
 *
 * Streaming is the whole task. A 500K-variant store's result file is hundreds of
 * megabytes; loading it works perfectly on a dev store and falls over on the first real
 * customer, which is precisely the class of bug behind this category's "the app froze"
 * reviews.
 *
 * The awkward part is that bulk JSONL is not a tree. A product arrives as one line and
 * each of its variants as separate lines carrying `__parentId`, and the grouping is not
 * guaranteed — so the parser reassembles relationships as it goes rather than assuming
 * a product's variants arrive together, or even soon after it.
 *
 * What is held in memory is bounded and deliberate: product-level fields only, one
 * small object per product, because a variant row needs its product's vendor and tags
 * and those arrive on a line that may be a hundred megabytes earlier. That is tens of
 * megabytes on a large store rather than hundreds, and it is the minimum the join
 * requires without a second pass over the file.
 */

import { parseMoney, type Money } from "../money/money";

/** A product line from the bulk query. */
export interface ProductLine {
  featuredImage?: { url?: string | null } | null;
  id: string;
  title?: string | null;
  vendor?: string | null;
  productType?: string | null;
  status?: string | null;
  tags?: string[] | null;
  updatedAt?: string | null;
  __parentId?: undefined;
}

/** A variant line, or a collection line, identified by its parent. */
export interface ChildLine {
  image?: { url?: string | null } | null;
  id: string;
  __parentId: string;
  title?: string | null;
  sku?: string | null;
  barcode?: string | null;
  price?: string | null;
  compareAtPrice?: string | null;
  inventoryQuantity?: number | null;
  inventoryItem?: { unitCost?: { amount?: string | null; currencyCode?: string | null } | null } | null;
  /** Present on collection lines, absent on variants. */
  handle?: string | null;
}

export interface CatalogRow {
  variantGid: string;
  productGid: string;
  title: string | null;
  sku: string | null;
  barcode: string | null;
  price: Money | null;
  compareAt: Money | null;
  cost: Money | null;
  inventoryQty: number | null;
  status: "ACTIVE" | "ARCHIVED" | "DRAFT";
  vendor: string | null;
  productType: string | null;
  tags: string[];
  collections: string[];
  remoteUpdatedAt: Date | null;
  imageUrl: string | null;
}

export interface ParseStats {
  products: number;
  variants: number;
  /** Variant lines whose product never appeared. Reported, never silently dropped. */
  orphans: number;
  malformed: number;
}

interface ProductState {
  gid: string;
  title: string | null;
  imageUrl: string | null;
  vendor: string | null;
  productType: string | null;
  status: "ACTIVE" | "ARCHIVED" | "DRAFT";
  tags: string[];
  collections: string[];
  updatedAt: Date | null;
}

/** True for a line that is a variant rather than a collection or other child. */
export function isVariantLine(line: ChildLine): boolean {
  return line.id.includes("/ProductVariant/");
}

export function isCollectionLine(line: ChildLine): boolean {
  return line.id.includes("/Collection/");
}

function toStatus(value: string | null | undefined): "ACTIVE" | "ARCHIVED" | "DRAFT" {
  const upper = (value ?? "").toUpperCase();
  return upper === "ARCHIVED" || upper === "DRAFT" ? upper : "ACTIVE";
}

/**
 * Turns a stream of JSONL lines into catalogue rows.
 *
 * Rows are yielded as soon as they can be completed, so a caller can batch and write
 * them without waiting for the file to end. A variant whose product has not been seen
 * is held back rather than emitted with nulls — a row claiming a product has no vendor
 * is worse than a row that arrives a moment later.
 */
export async function* parseCatalogJsonl(
  lines: AsyncIterable<string>,
  currency: string,
  stats: ParseStats = { products: 0, variants: 0, orphans: 0, malformed: 0 },
): AsyncGenerator<CatalogRow> {
  const products = new Map<string, ProductState>();
  /** Variants that arrived before their product. Rare, but not impossible. */
  const waiting = new Map<string, ChildLine[]>();

  for await (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed) continue;

    let line: ProductLine | ChildLine;
    try {
      line = JSON.parse(trimmed) as ProductLine | ChildLine;
    } catch {
      // One bad line must not end the import. A truncated write or an encoding
      // surprise costs that row, not the other four hundred thousand.
      stats.malformed++;
      continue;
    }

    if (!("__parentId" in line) || line.__parentId === undefined) {
      const product = line as ProductLine;
      products.set(product.id, {
        gid: product.id,
        title: product.title ?? null,
        imageUrl: product.featuredImage?.url ?? null,
        vendor: product.vendor ?? null,
        productType: product.productType ?? null,
        status: toStatus(product.status),
        tags: product.tags ?? [],
        collections: [],
        updatedAt: product.updatedAt ? new Date(product.updatedAt) : null,
      });
      stats.products++;

      // Anything that arrived early can now be completed.
      const held = waiting.get(product.id);
      if (held) {
        waiting.delete(product.id);
        for (const child of held) {
          const row = toRow(child, products.get(product.id)!, currency);
          if (row) {
            stats.variants++;
            yield row;
          }
        }
      }
      continue;
    }

    const child = line as ChildLine;
    const parent = products.get(child.__parentId);

    if (isCollectionLine(child)) {
      // Collections arrive as children too. Recorded on the product so later variants
      // carry them; variants already emitted keep whatever was known at the time,
      // which is why the query asks for collections before variants.
      if (parent) parent.collections.push(child.id);
      continue;
    }

    if (!isVariantLine(child)) continue;

    if (!parent) {
      const held = waiting.get(child.__parentId) ?? [];
      held.push(child);
      waiting.set(child.__parentId, held);
      continue;
    }

    const row = toRow(child, parent, currency);
    if (row) {
      stats.variants++;
      yield row;
    }
  }

  // Variants whose product never appeared. Counted and surfaced rather than dropped
  // quietly: a catalogue short by four hundred variants with no explanation is how a
  // campaign silently misses products.
  for (const held of waiting.values()) stats.orphans += held.length;
}

function toRow(child: ChildLine, product: ProductState, currency: string): CatalogRow | null {
  if (!child.id) return null;

  const cost = child.inventoryItem?.unitCost;

  return {
    variantGid: child.id,
    productGid: product.gid,
    // The variant's own image, falling back to its product's — the same rule the
    // paginated path uses. The two writing different values for the same variant,
    // depending only on catalogue size, is the shape of the bug that made bulk-imported
    // variants unpriceable (#252).
    imageUrl: child.image?.url ?? product.imageUrl,
    // The variant's own title where it has one, falling back to the product's. A bare
    // "Default Title" on its own tells a merchant nothing in a list of ten thousand.
    title:
      child.title && child.title !== "Default Title"
        ? `${product.title ?? ""} · ${child.title}`.trim()
        : (product.title ?? null),
    sku: child.sku ?? null,
    barcode: child.barcode ?? null,
    price: child.price ? parseMoney(child.price, currency) : null,
    compareAt: child.compareAtPrice ? parseMoney(child.compareAtPrice, currency) : null,
    cost: cost?.amount ? parseMoney(cost.amount, cost.currencyCode ?? currency) : null,
    inventoryQty: child.inventoryQuantity ?? null,
    status: product.status,
    vendor: product.vendor,
    productType: product.productType,
    tags: product.tags,
    collections: [...product.collections],
    remoteUpdatedAt: product.updatedAt,
  };
}

/**
 * The bulk query.
 *
 * Collections are asked for before variants so a product's collection lines arrive
 * first and every variant row carries them. Shopify emits children in field order,
 * which makes this the difference between a complete row and one that needs a second
 * pass over a hundred-megabyte file.
 */
export const CATALOG_BULK_QUERY = `
  {
    products {
      edges {
        node {
          id
          title
          vendor
          productType
          status
          tags
          updatedAt
          featuredImage { url }
          collections {
            edges { node { id } }
          }
          variants {
            edges {
              node {
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
    }
  }
`;
