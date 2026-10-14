/**
 * Which products a campaign covers by their status in Shopify (#751).
 *
 * Every scope used to cover ACTIVE, DRAFT and ARCHIVED products alike, because nothing
 * said otherwise: `astToWhere` left out deleted variants and gift cards, and a status
 * condition existed in the AST with no control anywhere that set it. A QA campaign scoped
 * to one title repriced an archived product and put its sale tag on it, and Home's "Put
 * everything on sale" counted -- and would have discounted -- products the storefront does
 * not sell. Each status had its own way of going wrong:
 *
 *   A **draft** is a product the merchant is still preparing. A sale rewrote its price;
 *   when they then set the price they wanted in Shopify, drift saw an edit on a variant the
 *   campaign controls and held the whole campaign. Published mid-sale, it launched at a
 *   price nobody chose for it.
 *
 *   An **archived** product gained a sale price and a sale badge, and came back from the
 *   archive already discounted.
 *
 * So a campaign covers active products, and draft or archived ones only when the merchant
 * ticks them in. **The default lives in the reader, not only in the writer:** a campaign
 * with nothing recorded -- every campaign made before this, and any caller that forgets --
 * covers active products. A default that had to be written by every path that creates a
 * campaign is a default one forgotten path takes away, which is how gift cards came to be
 * priced. What that means for campaigns already running is in `docs/decisions.md` (D12).
 *
 * Plain data, with no server imports, so the editor's checkboxes and the server's scope
 * read the same names.
 */

/** Shopify's `Product.status`, as the mirror stores it on every variant. */
export type ProductStatus = "ACTIVE" | "DRAFT" | "ARCHIVED";

/** Every status, in the order a sentence lists them. */
export const EVERY_STATUS: readonly ProductStatus[] = ["ACTIVE", "DRAFT", "ARCHIVED"];

/** What a campaign covers when nobody said otherwise: what the storefront sells. */
export const ACTIVE_ONLY: readonly ProductStatus[] = ["ACTIVE"];

/**
 * The editor's opt-ins, field name to the status it adds.
 *
 * Active has no field: a campaign that priced nothing on sale is not one anybody builds,
 * and a box for it would be one more way to make a scope that matches nothing.
 */
export const PRODUCT_STATUS_FIELDS = {
  includeDraft: "DRAFT",
  includeArchived: "ARCHIVED",
} as const satisfies Record<string, ProductStatus>;

/**
 * A stored list of statuses, made safe to query with.
 *
 * Unknown values are dropped -- the blob is JSON, so anything could be in it -- and an
 * absent or empty list is the default rather than "no status at all". An empty `IN ()`
 * would price nothing, and silently pricing nothing is a failure this app does not get to
 * call conservative: the merchant pressed Apply on a sale.
 *
 * Returned in `EVERY_STATUS` order, so two spellings of one choice compare equal.
 */
export function productStatusesOf(stored: unknown): ProductStatus[] {
  if (!Array.isArray(stored)) return [...ACTIVE_ONLY];
  const known = EVERY_STATUS.filter((status) => stored.includes(status));
  return known.length > 0 ? known : [...ACTIVE_ONLY];
}

/**
 * The statuses beyond active, in words, or null for the default.
 *
 * Silent for active-only, deliberately: it is what every campaign does unless told
 * otherwise, and "All variants · active products only" on every row of the campaigns list
 * would be a phrase repeated until nobody reads it. The opt-in is the exception, and the
 * exception is what has to be visible.
 */
export function describeProductStatuses(statuses: readonly ProductStatus[] | null | undefined): string | null {
  if (!statuses || statuses.length === 0) return null;

  const others = statuses.filter((status) => status !== "ACTIVE").map((status) => status.toLowerCase());
  if (others.length === 0) return null;

  const named = others.join(" and ");
  // Not reachable from the editor, which always keeps active. Said as what it is rather
  // than as "including", which would claim active products are covered when they are not.
  return statuses.includes("ACTIVE") ? `including ${named} products` : `${named} products only`;
}
