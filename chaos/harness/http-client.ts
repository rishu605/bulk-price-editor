/**
 * The client the engine uses against the fake.
 *
 * Deliberately built on the production `toAdminClient` adapter rather than a
 * hand-rolled one. That adapter is where a top-level GraphQL error becomes a thrown
 * Error and where Shopify's inconsistent `errors` shapes get flattened -- both of
 * which decide whether a fault is classified retryable or terminal. A harness with
 * its own adapter would test a client that never ships.
 */

import type { AdminClient } from "../../app/lib/execution/sync-executor";
import { toAdminClient, type ShopifyAdminContext } from "../../app/services/admin-client.server";

/**
 * The `admin` that `authenticate.admin` hands a route, answered by the fake. For a scenario
 * that replaces `authenticate.admin` and drives a route that asks Shopify something -- the
 * store's zone, since #799 -- through the route's own `toAdminClient(admin)`.
 */
export function chaosAdminContext(endpoint: string): ShopifyAdminContext {
  return {
    async graphql(query, options) {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables: options?.variables ?? {} }),
      });
      return { json: () => response.json() };
    },
  };
}

export function chaosAdminClient(endpoint: string): AdminClient {
  return toAdminClient(chaosAdminContext(endpoint));
}
