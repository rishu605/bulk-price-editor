/**
 * Empirically determines which access scopes each mutation the architecture needs
 * actually requires — by asking Shopify rather than reading the docs.
 *
 * **Why this exists.** Every scope is a checkbox a merchant reads before installing, and
 * each one costs install conversion. Widening scopes after launch forces a
 * re-authorisation prompt for every existing install, so the set has to be right before
 * the listing is built. The docs say `write_products` covers products, variants, price
 * lists and catalogs. That is an unusually generous claim and it turned out to be wrong
 * about Markets — the `markets` field answers "Access denied" under `write_products`
 * alone, which is why `read_markets`/`write_markets` are in the manifest.
 *
 * **How a probe can be safe.** Shopify checks authorization when it resolves the field,
 * *before* it validates the input. So a mutation that is going to fail its input
 * validation still tells us whether the scope is present — and it tells us without
 * changing anything. Every probe below therefore sends an input engineered to be
 * rejected: an id no store can hold, or an empty list. A `userErrors` response means the
 * mutation ran, considered our nonsense, and declined it. That is a pass.
 *
 * The alternative — writing a real price and putting it back — would be a live price
 * mutation with no ledger row behind it, which is precisely the thing invariant I4
 * exists to forbid. A probe that violates the product's central rule to prove the
 * product works is not a probe worth having.
 */

/**
 * An id above every id Shopify has issued, and above every one it will issue before this
 * code is gone. Well-formed, so it passes gid parsing and reaches the resolver; absurd,
 * so it cannot resolve to a real object on any store.
 *
 * The obvious choice — `.../1` — is well-formed too and *does* resolve on the oldest
 * stores in the world. Not ours, probably. "Probably" is doing far too much work in a
 * sentence about a mutation that could rename somebody's catalog.
 */
const IMPOSSIBLE = 9_007_199_254_740_991;

const gid = (type: string) => `gid://shopify/${type}/${IMPOSSIBLE}`;

export type ProbeVerdict = "granted" | "denied" | "inconclusive";

export interface ProbeResult {
  verdict: ProbeVerdict;
  /** What Shopify said, trimmed to one line. Empty when it said nothing useful. */
  detail: string;
  /** The scope named in an access-denied message, when it named one. */
  requires?: string;
}

export interface Probe {
  /** The mutation or field being probed, as it appears in RFC §6. */
  name: string;
  /** What the architecture needs it for — so a failure reads as a consequence. */
  purpose: string;
  /** The scope we believe covers it, to be confirmed or contradicted. */
  expects: string;
  document: string;
  variables: Record<string, unknown>;
  /**
   * The phase that first needs this, when it is not the one shipping now.
   *
   * A denial here is a scheduled cost, not a fault. Without the distinction the report
   * says "the app cannot do what it claims" about `read_companies`, which is true of no
   * feature that exists — B2B catalog assignment display is P6.1 — and a report that
   * raises an alarm about something working as designed trains people to skim it.
   */
  neededAt?: string;
}

/**
 * Pulls the verdict out of a GraphQL response body.
 *
 * The distinction that matters is *where* the failure came from. Shopify reports a
 * missing scope as a top-level `errors` entry — the field never resolved. It reports a
 * bad input as `userErrors` inside the payload — the field resolved, ran, and rejected
 * us. So a mutation that fails loudly on our deliberate nonsense is exactly what a
 * granted scope looks like.
 *
 * Anything else is `inconclusive` rather than a guess: a throttle, a network failure or
 * a schema change should read as "ask again", never as "denied". Reporting a throttled
 * probe as a missing scope would send somebody to widen the manifest, which is the one
 * outcome this whole exercise is meant to prevent.
 */
export function classifyProbe(body: unknown): ProbeResult {
  const { errors, data } = (body ?? {}) as {
    errors?: unknown;
    data?: Record<string, unknown> | null;
  };

  const topLevel = topLevelErrors(errors);

  const denial = topLevel.find(isAccessDenial);
  if (denial) {
    return { verdict: "denied", detail: denial, requires: requiredScope(denial) };
  }

  if (topLevel.length > 0) {
    return { verdict: "inconclusive", detail: topLevel.join("; ") };
  }

  // `data` present at all means the field resolved, which is the whole question. A null
  // payload with userErrors, a payload with an empty result — both are passes.
  if (data && Object.keys(data).length > 0) {
    return { verdict: "granted", detail: firstUserError(data) ?? "" };
  }

  return { verdict: "inconclusive", detail: "no data and no errors" };
}

/**
 * Shopify's error shape is not consistent — an array per the spec for field-level
 * failures, a bare object such as `{"query": "Throttled"}` for request-level ones. Both
 * are flattened to a list of strings here, for the same reason the admin client does it:
 * assuming the array cost real time once already.
 */
function topLevelErrors(errors: unknown): string[] {
  if (!errors) return [];

  if (Array.isArray(errors)) {
    return errors.map(
      (entry) => (entry as { message?: string })?.message ?? JSON.stringify(entry),
    );
  }

  if (typeof errors === "string") return [errors];

  if (typeof errors === "object") {
    return Object.entries(errors as Record<string, unknown>).map(
      ([key, value]) =>
        `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`,
    );
  }

  return [String(errors)];
}

function isAccessDenial(message: string): boolean {
  return /access denied|required access|not approved to access/i.test(message);
}

/**
 * The scope named inside an access-denied message.
 *
 * Shopify is unusually helpful here — "Required access: `read_markets` access scope" —
 * and quoting it back is better than inferring, because the message is what the merchant
 * would be asked to grant.
 */
function requiredScope(message: string): string | undefined {
  return /`([a-z_]+)`\s*access scope/i.exec(message)?.[1];
}

function firstUserError(data: Record<string, unknown>): string | null {
  for (const payload of Object.values(data)) {
    const errors = (payload as { userErrors?: Array<{ message?: string }> } | null)
      ?.userErrors;
    if (errors?.length) return errors[0]?.message ?? null;
  }
  return null;
}

/**
 * Every mutation and field the architecture depends on, one probe each.
 *
 * The list is RFC §6's, plus the two read fields whose necessity is itself the open
 * question: `markets` (already proven to need its own scope) and `companies` (needed
 * only if catalog *assignment* has to be displayed, which decides whether P6.1 forces a
 * scope change on every existing install).
 */
export const PROBES: Probe[] = [
  {
    name: "productVariantsBulkUpdate",
    purpose: "base-price writes — the primary surface",
    expects: "write_products",
    document: `#graphql
      mutation AnchorProbeVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) {
          userErrors { field message }
        }
      }
    `,
    variables: { productId: gid("Product"), variants: [] },
  },
  {
    name: "bulkOperationRunQuery",
    purpose: "catalog mirror sync",
    expects: "read_products",
    document: `#graphql
      mutation AnchorProbeBulkQuery($query: String!) {
        bulkOperationRunQuery(query: $query) {
          userErrors { field message }
        }
      }
    `,
    // Deliberately not a query. A valid one would start a real bulk operation, and this
    // shop may only run one at a time — a probe that occupies that slot is a probe that
    // breaks the thing it is checking.
    variables: { query: "this is not a graphql document" },
  },
  {
    name: "bulkOperationRunMutation",
    purpose: "large price writes via JSONL",
    expects: "write_products",
    document: `#graphql
      mutation AnchorProbeBulkMutation($mutation: String!, $stagedUploadPath: String!) {
        bulkOperationRunMutation(mutation: $mutation, stagedUploadPath: $stagedUploadPath) {
          userErrors { field message }
        }
      }
    `,
    variables: { mutation: "not a mutation", stagedUploadPath: "nonexistent" },
  },
  {
    name: "stagedUploadsCreate",
    purpose: "uploading the JSONL a bulk mutation reads",
    expects: "write_products",
    document: `#graphql
      mutation AnchorProbeStagedUploads($input: [StagedUploadInput!]!) {
        stagedUploadsCreate(input: $input) {
          userErrors { field message }
        }
      }
    `,
    // An empty list stages nothing. This is the one probe that may legitimately succeed
    // rather than fail, which is fine — success is an even clearer pass.
    variables: { input: [] },
  },
  {
    name: "priceListCreate",
    purpose: "creating a market price list",
    expects: "write_products",
    document: `#graphql
      mutation AnchorProbePriceListCreate($input: PriceListCreateInput!) {
        priceListCreate(input: $input) {
          userErrors { field message }
        }
      }
    `,
    // A catalog id that cannot resolve, so validation rejects it before anything is
    // created. Without that the probe would leave a price list behind on every run.
    variables: {
      input: {
        name: "anchor-scope-probe",
        currency: "USD",
        catalogId: gid("Catalog"),
        parent: { adjustment: { type: "PERCENTAGE_DECREASE", value: 1 } },
      },
    },
  },
  {
    name: "priceListUpdate",
    purpose: "market-wide repricing in one mutation",
    expects: "write_products",
    document: `#graphql
      mutation AnchorProbePriceListUpdate($id: ID!, $input: PriceListUpdateInput!) {
        priceListUpdate(id: $id, input: $input) {
          userErrors { field message }
        }
      }
    `,
    variables: { id: gid("PriceList"), input: {} },
  },
  {
    name: "priceListFixedPricesAdd",
    purpose: "per-market prices **with compare-at** — the wedge",
    expects: "write_products",
    document: `#graphql
      mutation AnchorProbeFixedPricesAdd($priceListId: ID!, $prices: [PriceListPriceInput!]!) {
        priceListFixedPricesAdd(priceListId: $priceListId, prices: $prices) {
          userErrors { field message }
        }
      }
    `,
    variables: { priceListId: gid("PriceList"), prices: [] },
  },
  {
    name: "priceListFixedPricesDelete",
    purpose: "reverting a market surface",
    expects: "write_products",
    document: `#graphql
      mutation AnchorProbeFixedPricesDelete($priceListId: ID!, $variantIds: [ID!]!) {
        priceListFixedPricesDelete(priceListId: $priceListId, variantIds: $variantIds) {
          userErrors { field message }
        }
      }
    `,
    variables: { priceListId: gid("PriceList"), variantIds: [] },
  },
  {
    name: "quantityPricingByVariantUpdate",
    purpose: "B2B quantity price breaks",
    expects: "write_products",
    neededAt: "P6.1",
    document: `#graphql
      mutation AnchorProbeQuantityPricing($priceListId: ID!, $input: QuantityPricingByVariantUpdateInput!) {
        quantityPricingByVariantUpdate(priceListId: $priceListId, input: $input) {
          userErrors { field message }
        }
      }
    `,
    variables: {
      priceListId: gid("PriceList"),
      input: {
        pricesToAdd: [],
        pricesToDeleteByVariantId: [],
        quantityPriceBreaksToAdd: [],
        quantityPriceBreaksToDelete: [],
        quantityRulesToAdd: [],
        quantityRulesToDeleteByVariantId: [],
      },
    },
  },
  {
    name: "catalogCreate",
    purpose: "B2B catalog surface",
    expects: "write_products",
    neededAt: "P6.1",
    document: `#graphql
      mutation AnchorProbeCatalogCreate($input: CatalogCreateInput!) {
        catalogCreate(input: $input) {
          userErrors { field message }
        }
      }
    `,
    // Pinned to a market that cannot exist, so nothing is created.
    variables: {
      input: {
        title: "anchor-scope-probe",
        status: "DRAFT",
        context: { marketIds: [gid("Market")] },
      },
    },
  },
  {
    name: "catalogUpdate",
    purpose: "attaching a price list to a catalog",
    expects: "write_products",
    document: `#graphql
      mutation AnchorProbeCatalogUpdate($id: ID!, $input: CatalogUpdateInput!) {
        catalogUpdate(id: $id, input: $input) {
          userErrors { field message }
        }
      }
    `,
    variables: { id: gid("Catalog"), input: {} },
  },
  {
    name: "tagsAdd",
    purpose: "campaign-scoped tags — the only storefront hook we allow ourselves",
    expects: "write_products",
    document: `#graphql
      mutation AnchorProbeTagsAdd($id: ID!, $tags: [String!]!) {
        tagsAdd(id: $id, tags: $tags) {
          userErrors { field message }
        }
      }
    `,
    variables: { id: gid("Product"), tags: [] },
  },
  {
    name: "tagsRemove",
    purpose: "removing them when a campaign ends",
    expects: "write_products",
    document: `#graphql
      mutation AnchorProbeTagsRemove($id: ID!, $tags: [String!]!) {
        tagsRemove(id: $id, tags: $tags) {
          userErrors { field message }
        }
      }
    `,
    variables: { id: gid("Product"), tags: [] },
  },
  {
    name: "markets (query)",
    purpose: "reading which markets exist, before pricing into any of them",
    expects: "read_markets",
    document: `#graphql
      query AnchorProbeMarkets {
        markets(first: 1) { nodes { id } }
      }
    `,
    variables: {},
  },
  {
    name: "companies (query)",
    purpose: "displaying which companies a B2B catalog is assigned to",
    expects: "read_companies",
    neededAt: "P6.1",
    document: `#graphql
      query AnchorProbeCompanies {
        companies(first: 1) { nodes { id } }
      }
    `,
    variables: {},
  },
];

/**
 * The set of scopes to actually declare, given the set the probes proved necessary.
 *
 * Shopify implies `read_x` from `write_x`, and collapses the pair when it records what a
 * shop granted — the session row for a manifest asking for
 * `write_products,read_markets,write_markets` comes back saying `write_markets,
 * write_products`. Declaring the implied half is therefore a checkbox on the install
 * screen that buys nothing, and this app was declaring one.
 *
 * Kept as a function rather than a hand-edited string because the naive union of what
 * each probe expects is what a person would write down, and it is wrong in exactly this
 * way: `bulkOperationRunQuery` needs read access to products, so `read_products` looks
 * like part of the answer right up until you notice `write_products` is already there.
 */
export function minimalScopes(needed: Iterable<string>): string[] {
  const set = new Set(needed);
  for (const scope of [...set]) {
    if (scope.startsWith("read_") && set.has(`write_${scope.slice("read_".length)}`)) {
      set.delete(scope);
    }
  }
  return [...set].sort();
}

export interface ScopeGaps {
  /** Needed, and not covered by anything granted. The app is broken until these land. */
  missing: string[];
  /** Granted as write where only read was ever exercised. A wider prompt than earned. */
  overBroad: string[];
  /** Granted and never exercised at all. A checkbox with nothing behind it. */
  unneeded: string[];
}

/**
 * Compares what a shop granted against what the probes proved necessary.
 *
 * The three answers are deliberately kept apart because they call for different actions.
 * `missing` is a bug — something the app does will fail. `unneeded` is a scope to delete.
 * `overBroad` is the subtle one: the manifest asks to *manage* markets when it only ever
 * *reads* them, and the difference is the wording of the sentence a merchant reads on
 * the install screen. "View your markets" and "manage your markets" are not the same ask
 * of somebody about to hand a pricing app access to their store.
 *
 * None of this proves a scope is removable. This probe reports what fails under the
 * grant in force, and a scope that is present is never exercised as absent — confirming
 * a removal means narrowing the manifest, reinstalling, and asking again.
 */
export function scopeGaps(granted: Iterable<string>, needed: Iterable<string>): ScopeGaps {
  const have = new Set(granted);
  const want = new Set(needed);

  const covers = (scope: string) =>
    have.has(scope) ||
    (scope.startsWith("read_") && have.has(`write_${scope.slice("read_".length)}`));

  const missing = [...want].filter((scope) => !covers(scope)).sort();

  const overBroad = [...have]
    .filter(
      (scope) =>
        scope.startsWith("write_") &&
        !want.has(scope) &&
        want.has(`read_${scope.slice("write_".length)}`),
    )
    .sort();

  const unneeded = [...have]
    .filter((scope) => {
      if (want.has(scope)) return false;
      const suffix = scope.replace(/^(read|write)_/, "");
      return !want.has(`read_${suffix}`) && !want.has(`write_${suffix}`);
    })
    .sort();

  return { missing, overBroad, unneeded };
}
