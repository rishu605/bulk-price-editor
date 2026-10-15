/**
 * A variant's name as the app shows it: its product's title, then its own (#782).
 *
 * Shopify names the only variant of a product with no options "Default Title". That on its
 * own tells a merchant nothing in a list of ten thousand, so it is dropped and the product's
 * title stands alone. One helper, because the three paths that store the title -- the bulk
 * sync, the paginated sync and the products webhook -- each had their own rule, and the
 * webhook kept "QA Recapture Board · Default Title" that the bulk sync would have dropped.
 */
export function variantDisplayTitle(
  productTitle: string | null | undefined,
  variantTitle: string | null | undefined,
): string | null {
  const own = variantTitle && variantTitle !== "Default Title" ? variantTitle : null;
  const parts = [productTitle, own].filter((part): part is string => Boolean(part && part.trim()));
  return parts.length > 0 ? parts.join(" · ") : null;
}
