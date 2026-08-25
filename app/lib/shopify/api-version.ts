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
