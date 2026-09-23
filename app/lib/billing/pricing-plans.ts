/**
 * The link to Shopify's own plan picker.
 *
 * Shopify App Pricing hosts the page a merchant actually subscribes on; the app's job is
 * to get them there. App Bridge resolves a `shopify://admin/...` href against whatever
 * admin the app is embedded in, so the link needs the app's handle and nothing about the
 * shop — which is what stops it being a second copy of a store's identity that can drift.
 *
 * Pure, and separate from the query that answers the handle, because the part that goes
 * wrong is the shape of the URL and that part should not need a network call to test.
 */

/** The `shopify://` scheme is App Bridge's; a browser cannot resolve it on its own. */
const ADMIN = "shopify://admin";

/**
 * Where the merchant chooses a plan, or null if we do not know the handle.
 *
 * Null rather than a guess. A pricing link that 404s from the one screen where somebody
 * has decided to pay is worse than no link: they conclude the app is broken at exactly
 * the moment they were reaching for their card.
 */
export function pricingPlansUrl(handle: string | null | undefined): string | null {
  const trimmed = handle?.trim();
  if (!trimmed) return null;

  // Handles are lowercase, alphanumeric and hyphenated. Anything else is not a handle we
  // read from the API, so refuse it rather than interpolate it into a URL.
  if (!/^[a-z0-9][a-z0-9-]*$/.test(trimmed)) return null;

  return `${ADMIN}/charges/${trimmed}/pricing_plans`;
}
