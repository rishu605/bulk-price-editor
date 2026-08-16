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
