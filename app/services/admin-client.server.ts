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
import { API_VERSION_STRING } from "../lib/shopify/api-version";
import { span } from "../lib/observability/otel.server";
import { decryptToken, isEncrypted } from "../lib/crypto/secrets";
import { logger } from "../lib/logging/logger";

export interface ShopifyAdminContext {
  graphql(
    query: string,
    options?: { variables?: Record<string, unknown> },
  ): Promise<{ json(): Promise<unknown> }>;
}

export function toAdminClient(admin: ShopifyAdminContext): AdminClient {
  return {
    async request<T>(query: string, variables: Record<string, unknown>) {
      // One span per Admin API call, carrying the cost points and what was left in the
      // bucket afterwards. That pair is what turns "the run was slow" into "the run was
      // slow because this shop's budget was exhausted", which is the difference between
      // a graph and a diagnosis.
      //
      // The operation name, never the query body — a mutation's variables carry prices.
      return span("shopify.graphql", { "graphql.operation": operationName(query) }, async (active) => {
        const response = await admin.graphql(query, { variables });
        const body = (await response.json()) as {
          data?: T;
          extensions?: { cost?: QueryCost };
          errors?: unknown;
        };

        const cost = body.extensions?.cost;
        if (active && cost) {
          active.setAttribute("shopify.cost.requested", cost.requestedQueryCost ?? 0);
          active.setAttribute("shopify.cost.actual", cost.actualQueryCost ?? 0);
          active.setAttribute(
            "shopify.throttle.available",
            cost.throttleStatus?.currentlyAvailable ?? -1,
          );
        }

        // Top-level GraphQL errors are transport-level failures, distinct from the
        // per-row `userErrors` the executors map back to individual variants.
        const message = formatGraphQLErrors(body.errors);
        if (message) throw new Error(message);

        return { data: body.data, extensions: body.extensions };
      });
    },
  };
}

/**
 * The operation name from a GraphQL document.
 *
 * Never the document itself and never the variables: a price mutation's variables are
 * exactly the thing that must not be exported, and a query body as a span attribute is
 * both enormous and unhelpful.
 */
export function operationName(query: string): string {
  return /\b(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? "anonymous";
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

  // Decrypted here, because this path never goes through the session storage that
  // encrypted it. The web process gets its token from Shopify's session machinery, which
  // wraps `EncryptedSessionStorage`; the worker reads the row directly and would
  // otherwise send ciphertext as a bearer token. Shopify answers that with "Invalid API
  // key or access token", which reads like a misconfigured app and sends you looking
  // anywhere but here — it broke every scheduled run, the nightly mirror audit and the
  // reconciliation spot check at once, and all three failed the same misleading way.
  //
  // Plaintext falls through unchanged so a shop installed before encryption keeps
  // working until its token is next rewritten.
  const accessToken = decryptedToken(session.accessToken);
  if (!accessToken) {
    logger.error("stored token could not be decrypted", { shop: shopDomain });
    return null;
  }

  // The same version the web process speaks. This used to read an environment variable
  // with a different default, so a scheduled run hit a different Admin API than the
  // identical run started by hand — invisible in the code, and only ever failing
  // overnight.
  const endpoint = `https://${shopDomain}/admin/api/${API_VERSION_STRING}/graphql.json`;

  return toAdminClient({
    async graphql(query, options) {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({ query, variables: options?.variables ?? {} }),
      });
      return { json: () => response.json() };
    },
  });
}


/**
 * A stored token, whichever form it is in.
 *
 * Returns null only when a token that *is* encrypted cannot be read — a wrong or missing
 * key. Failing loudly there is right: the alternative is sending ciphertext to Shopify
 * and reporting its authentication error, which blames the wrong thing.
 */
export function decryptedToken(stored: string): string | null {
  if (!isEncrypted(stored)) return stored;

  const secret = process.env.TOKEN_ENCRYPTION_KEY;
  if (!secret) return null;

  return decryptToken(stored, secret);
}
