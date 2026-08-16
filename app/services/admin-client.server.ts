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
        errors?: Array<{ message: string }>;
      };

      // Top-level GraphQL errors are transport-level failures, distinct from the
      // per-row `userErrors` the executors map back to individual variants.
      if (body.errors?.length) {
        throw new Error(body.errors.map((e) => e.message).join("; "));
      }

      return { data: body.data, extensions: body.extensions };
    },
  };
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

  const session = await prisma.session.findFirst({
    where: { shop: shopDomain, accessToken: { not: "" } },
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
