/**
 * Which variants a `products/*` webhook says the product still has (#729).
 *
 * The handler tombstones every mirrored variant the payload does not mention. That is
 * only safe when the payload mentions every variant, and product webhooks do not: they
 * carry full details for the first 100 variants and nothing more in `variants`. Shopify
 * added `variant_gids` to every webhook version for that reason -- a list of ids,
 * `[{ admin_graphql_api_id }]`, that covers the variants `variants` leaves out.
 *
 * Reading `variants` alone tombstoned variant 101 onward on every update to a large
 * product -- and every order and every one of Anchor's own writes is an update. A
 * campaign's revert then skipped them as deleted and left them on sale.
 */

/** The most variants a product webhook describes in full. */
export const WEBHOOK_VARIANT_DETAIL_LIMIT = 100;

export interface WebhookVariantRef {
  id?: number | string;
  admin_graphql_api_id?: string;
}

export interface ProductVariantLists {
  variants?: WebhookVariantRef[];
  /** Shopify sends objects; a bare string is accepted too, rather than dropped. */
  variant_gids?: Array<{ admin_graphql_api_id?: string } | string> | null;
}

export function variantGidOf(variant: WebhookVariantRef): string {
  return variant.admin_graphql_api_id ?? `gid://shopify/ProductVariant/${variant.id}`;
}

/**
 * Every variant the product still has, or null when this payload cannot say.
 *
 * With `variant_gids` the answer is it, together with `variants` -- the union, so a
 * payload shaped either way round loses nothing. Without it, `variants` is only known to
 * be the whole list when it is shorter than the detail limit; at or over the limit there
 * may be more that nobody mentioned, and the answer is null rather than a guess. Null
 * for an empty payload too: a delivery listing nothing is not "the merchant deleted all
 * of them".
 */
export function variantsStillOnProduct(product: ProductVariantLists): Set<string> | null {
  const described = (product.variants ?? []).map(variantGidOf);

  if (Array.isArray(product.variant_gids) && product.variant_gids.length > 0) {
    const listed = product.variant_gids
      .map((entry) => (typeof entry === "string" ? entry : entry?.admin_graphql_api_id))
      .filter((gid): gid is string => typeof gid === "string" && gid.length > 0);
    return new Set([...described, ...listed]);
  }

  if (described.length === 0 || described.length >= WEBHOOK_VARIANT_DETAIL_LIMIT) return null;
  return new Set(described);
}
