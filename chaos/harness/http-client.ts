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
import { toAdminClient } from "../../app/services/admin-client.server";

export function chaosAdminClient(endpoint: string): AdminClient {
  return toAdminClient({
    async graphql(query, options) {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables: options?.variables ?? {} }),
      });
      return { json: () => response.json() };
    },
  });
}
