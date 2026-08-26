/**
 * The one Admin API version this app speaks.
 *
 * It was two. `shopify.server.ts` pinned October25 while `adminClientForShop` — the
 * client the *worker* uses — defaulted to an unrelated version from an environment
 * variable nobody set. Same queries, same code, two API versions depending on whether a
 * run was clicked or scheduled. That produces the worst shape of bug there is: works
 * when you try it, fails overnight, and the difference is invisible in the code you are
 * reading.
 *
 * So it lives here, exported once, with no env override. An API version is not
 * configuration — it is a contract that the generated types, the pinned schema and every
 * query in the app are written against together, and letting a deployment change it
 * independently means the types no longer describe what comes back.
 */

import { ApiVersion } from "@shopify/shopify-app-react-router/server";

/** The pinned version. Changing it means regenerating types and re-reading the diff. */
export const API_VERSION = ApiVersion.October25;

/** The same value as a plain string, for URL construction and codegen config. */
export const API_VERSION_STRING: string = API_VERSION;

/**
 * When Shopify stops supporting the pinned version.
 *
 * Admin API versions are released quarterly and supported for twelve months, so a pin is
 * a dated thing whether or not anybody writes the date down. Built for Shopify requires a
 * supported version, and the failure mode without a check is the worst kind: nothing in
 * the repo changes, and one morning the API starts refusing calls.
 *
 * Derived from the version string rather than maintained by hand, so bumping the pin
 * moves the deadline automatically.
 */
export function supportedUntil(version: string = API_VERSION_STRING): Date {
  const match = /^(\d{4})-(\d{2})$/.exec(version);
  if (!match) throw new Error(`Not a Shopify API version: ${version}`);

  const year = Number(match[1]);
  const month = Number(match[2]);

  // Twelve months after release, at the start of that month. UTC, because the deadline
  // is Shopify's and does not move with the machine running the test.
  return new Date(Date.UTC(year + 1, month - 1, 1));
}
