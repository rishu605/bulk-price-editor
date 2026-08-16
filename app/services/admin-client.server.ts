/**
 * Adapts Shopify's authenticated admin context to the small `AdminClient`
 * interface the executors depend on.
 *
 * The executors are written against a two-method interface so their tests can inject
 * a fake and never touch the network. This is the one place that knows the real
 * client returns a `Response` needing `.json()`, rather than a decoded body.
 */

import type { QueryCost } from "../lib/shopify/budget";
import type { AdminClient } from "../lib/execution/sync-executor";

export interface ShopifyAdminContext {
  graphql(
    query: string,
    options?: { variables?: Record<string, unknown> },
  ): Promise<{ json(): Promise<unknown> }>;
}

export function toAdminClient(admin: ShopifyAdminContext): AdminClient {
  return {
    async request<T>(query: string, variables: Record<string, unknown>) {
      const response = await admin.graphql(query, { variables });
      const body = (await response.json()) as {
        data?: T;
        extensions?: { cost?: QueryCost };
        errors?: unknown;
      };

      // Top-level GraphQL errors are transport-level failures, distinct from the
      // per-row `userErrors` the executors map back to individual variants.
      const message = formatGraphQLErrors(body.errors);
      if (message) throw new Error(message);

      return { data: body.data, extensions: body.extensions };
    },
  };
}


/**
 * Renders whatever Shopify put in `errors` as a single message.
 *
 * The shape is not consistent. Field-level failures come back as the array the spec
 * describes, but request-level ones -- a malformed query, a throttle -- arrive as a
 * bare object such as `{"query": "Throttled"}`. Assuming an array turned every one of
 * those into `body.errors.map is not a function`, which replaced the real cause with
 * a TypeError from inside our own client at precisely the moment we needed to know
 * what Shopify actually said.
 */
function formatGraphQLErrors(errors: unknown): string | null {
  if (!errors) return null;

  if (Array.isArray(errors)) {
    if (errors.length === 0) return null;
    return errors
      .map((entry) => (entry as { message?: string })?.message ?? JSON.stringify(entry))
      .join("; ");
  }

  if (typeof errors === "string") return errors;

  if (typeof errors === "object") {
    const entries = Object.entries(errors as Record<string, unknown>);
    if (entries.length === 0) return null;
    return entries
      .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
      .join("; ");
  }

  return String(errors);
}

/**
 * Builds a client for a shop from its stored offline session.
 *
 * The worker has no request to authenticate, so it reads the token directly. This
 * returns null rather than throwing when there is no usable session -- an
 * uninstalled shop is an expected state for a background tick, not an error.
 */
export async function adminClientForShop(shopDomain: string): Promise<AdminClient | null> {
  const { default: prisma } = await import("../db.server");

  // Offline sessions first: they are the ones that outlive a browser tab, which is the
  // whole point for a worker with no request to authenticate. An expired token is
  // filtered out rather than used, because Shopify answers a dead token with
  // "Invalid API key or access token" -- which reads like a misconfigured app and
  // sends you looking in entirely the wrong place. Returning null instead surfaces as
  // NO_SESSION: "reinstall the app", which is the actual remedy.
  const session = await prisma.session.findFirst({
    where: {
      shop: shopDomain,
      accessToken: { not: "" },
      OR: [{ expires: null }, { expires: { gt: new Date() } }],
    },
    orderBy: [{ isOnline: "asc" }, { expires: "desc" }],
  });
  if (!session?.accessToken) return null;

  const apiVersion = process.env.SHOPIFY_API_VERSION ?? "2026-07";
  const endpoint = `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`;

  return toAdminClient({
    async graphql(query, options) {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": session.accessToken,
        },
        body: JSON.stringify({ query, variables: options?.variables ?? {} }),
      });
      return { json: () => response.json() };
    },
  });
}
