/**
 * An in-process Shopify Admin API, honest enough that breaking it means something.
 *
 * The chaos suite has to run in CI in minutes, which rules out a real store: rate
 * limits alone would put a 429-storm scenario out of reach, and a test that deletes
 * products on a live shop is not one anybody will run on every release.
 *
 * So this models the parts of the Admin API the write paths actually depend on, and
 * -- crucially -- models the *awkward* parts faithfully rather than the happy ones:
 *
 *   `userErrors` come back with HTTP 200. A fake that threw on rejection would let
 *   the executor's most important branch go untested.
 *
 *   `extensions.cost.throttleStatus` is returned on every response and the bucket
 *   really does drain, so the budget manager is exercised against a moving target
 *   instead of a constant.
 *
 *   A bulk operation does not finish on submission. It stays RUNNING for a few polls,
 *   which is what makes the missed-`finish`-webhook fallback a real test (E13).
 *
 * State is public on purpose: scenarios assert against `variants` to answer "what
 * does the store actually say now", which is the only question that matters.
 */

import type { BulkOperationState } from "../../app/lib/execution/bulk-executor";
import type { QueryCost, ThrottleStatus } from "../../app/lib/shopify/budget";
import type { BulkResultLine } from "../../app/lib/execution/jsonl";
import type { BlobStore } from "./blob-store";

export interface FakeProduct {
  productGid: string;
  /** Shopify stores tags per product, and treats them case-insensitively. */
  tags: string[];
}

export interface FakeVariant {
  variantGid: string;
  productGid: string;
  /** Shopify's decimal string form, e.g. "80.00" -- not minor units. */
  price: string;
  compareAtPrice: string | null;
  /** Deleted in Shopify. Still readable here so the mirror can be stale, as in life. */
  deleted: boolean;
}

export interface FakeOptions {
  blobs: BlobStore;
  /** Polls a submitted bulk operation stays RUNNING before it completes. */
  pollsBeforeComplete?: number;
  throttle?: ThrottleStatus;
}

const DEFAULT_THROTTLE: ThrottleStatus = {
  maximumAvailable: 1_000,
  currentlyAvailable: 1_000,
  restoreRate: 50,
};

export class FakeShopify {
  readonly variants = new Map<string, FakeVariant>();

  /** Product-level state. Tags live here, not on variants, exactly as in Shopify. */
  readonly products = new Map<string, FakeProduct>();

  /** Every variant write this fake has accepted, in order. Scenarios assert on it. */
  readonly writeLog: Array<{ variantGid: string; price: string }> = [];

  /** Bulk-operation status polls served. Proof the fallback did the recovering. */
  polls = 0;

  private readonly blobs: BlobStore;
  private readonly pollsBeforeComplete: number;
  private throttle: ThrottleStatus;

  /** When the bucket was last recomputed, so it restores with the clock. */
  private throttleAt = Date.now();

  private bulk?: BulkOperationState;
  private bulkBody?: string;
  private bulkPolls = 0;
  private stagedSeq = 0;

  constructor(options: FakeOptions) {
    this.blobs = options.blobs;
    this.pollsBeforeComplete = options.pollsBeforeComplete ?? 2;
    this.throttle = { ...(options.throttle ?? DEFAULT_THROTTLE) };
  }

  // ------------------------------------------------------------- store fixture

  addVariant(variant: Omit<FakeVariant, "deleted">): void {
    this.variants.set(variant.variantGid, { ...variant, deleted: false });
    if (!this.products.has(variant.productGid)) {
      this.products.set(variant.productGid, { productGid: variant.productGid, tags: [] });
    }
  }

  /** Tags currently on a product, as the storefront would see them. */
  tagsOf(productGid: string): string[] {
    return this.products.get(productGid)?.tags ?? [];
  }

  /** Puts a tag on a product without the app's involvement -- the merchant's own. */
  addMerchantTag(productGid: string, tag: string): void {
    const product = this.products.get(productGid);
    if (product && !product.tags.some((t) => t.toLowerCase() === tag.toLowerCase())) {
      product.tags.push(tag);
    }
  }

  /**
   * Deletes a variant the way a merchant does mid-run: gone from Shopify, still
   * present in our mirror because the `products/delete` webhook has not landed (E4).
   */
  deleteVariant(variantGid: string): void {
    const variant = this.variants.get(variantGid);
    if (variant) variant.deleted = true;
  }

  priceOf(variantGid: string): string | undefined {
    const variant = this.variants.get(variantGid);
    return variant && !variant.deleted ? variant.price : undefined;
  }

  // ------------------------------------------------------------- the API itself

  async request<T = unknown>(
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<{ data?: T; extensions?: { cost?: QueryCost } }> {
    if (query.includes("productVariantsBulkUpdate")) {
      return this.bulkUpdate(variables) as { data?: T; extensions?: { cost?: QueryCost } };
    }
    if (query.includes("stagedUploadsCreate")) {
      return this.stagedUploadsCreate() as { data?: T; extensions?: { cost?: QueryCost } };
    }
    if (query.includes("bulkOperationRunMutation")) {
      return this.runBulkMutation(variables) as { data?: T; extensions?: { cost?: QueryCost } };
    }
    if (query.includes("currentBulkOperation")) {
      return this.currentBulkOperation() as { data?: T; extensions?: { cost?: QueryCost } };
    }
    if (query.includes("tagsAdd")) {
      return this.tagsAdd(variables) as { data?: T; extensions?: { cost?: QueryCost } };
    }
    if (query.includes("tagsRemove")) {
      return this.tagsRemove(variables) as { data?: T; extensions?: { cost?: QueryCost } };
    }
    if (query.includes("nodes(")) {
      return this.nodes(variables, query) as { data?: T; extensions?: { cost?: QueryCost } };
    }
    throw new Error(`FakeShopify has no handler for this query: ${query.slice(0, 80)}`);
  }

  /**
   * Cost extension, with a bucket that drains on spend and restores with the clock.
   *
   * The restore half is not decoration. The budget manager mirrors whatever
   * `throttleStatus` reports rather than assuming a plan, so a fake that only ever
   * drained would report a bucket sliding to zero and stay there -- and the manager,
   * behaving perfectly correctly on the numbers it was given, would slow every
   * subsequent run to the restore rate. That looked exactly like an engine bug for as
   * long as it took to notice the fake was the thing lying.
   */
  private cost(spend: number): { cost: QueryCost } {
    const now = Date.now();
    const restored = ((now - this.throttleAt) / 1_000) * this.throttle.restoreRate;
    this.throttleAt = now;

    const available = Math.min(
      this.throttle.maximumAvailable,
      this.throttle.currentlyAvailable + restored,
    );

    this.throttle = {
      ...this.throttle,
      currentlyAvailable: Math.max(0, Math.round(available - spend)),
    };

    return {
      cost: {
        requestedQueryCost: spend,
        actualQueryCost: spend,
        throttleStatus: { ...this.throttle },
      },
    };
  }

  private applyVariantInputs(inputs: Array<Record<string, unknown>>) {
    const productVariants: Array<{ id: string; price: string; compareAtPrice: string | null }> = [];
    const userErrors: Array<{ field: string[]; message: string; code?: string }> = [];

    inputs.forEach((input, index) => {
      const id = String(input.id);
      const variant = this.variants.get(id);

      // The two ways a write legitimately does not land. Both come back as
      // userErrors on a 200, which is the whole point of modelling them here.
      if (!variant || variant.deleted) {
        userErrors.push({
          field: ["variants", String(index), "id"],
          message: `Variant ${id} does not exist.`,
          code: "NOT_FOUND",
        });
        return;
      }

      if (typeof input.price === "string") {
        variant.price = input.price;
        this.writeLog.push({ variantGid: id, price: input.price });
      }
      if ("compareAtPrice" in input) {
        variant.compareAtPrice = input.compareAtPrice === null ? null : String(input.compareAtPrice);
      }

      productVariants.push({
        id,
        price: variant.price,
        compareAtPrice: variant.compareAtPrice,
      });
    });

    return { productVariants, userErrors };
  }

  private bulkUpdate(variables: Record<string, unknown>) {
    const inputs = (variables.variants ?? []) as Array<Record<string, unknown>>;
    const payload = this.applyVariantInputs(inputs);
    return {
      data: { productVariantsBulkUpdate: payload },
      extensions: this.cost(10 * Math.max(1, inputs.length)),
    };
  }

  private nodes(variables: Record<string, unknown>, query = "") {
    const ids = (variables.ids ?? []) as string[];

    // The same `nodes` field serves products and variants; the requested fragment is
    // what distinguishes them, exactly as it does against the real API.
    //
    // Tested for `ProductVariant` first, because "... on ProductVariant" contains the
    // substring "on Product" -- checking the shorter one first routed every price
    // read-back to the tag handler, which answered with tags and no price, and every
    // verified row in the suite turned unverified.
    if (!query.includes("on ProductVariant") && query.includes("on Product")) {
      return {
        data: {
          nodes: ids.map((id) => {
            const product = this.products.get(id);
            return product ? { id, tags: [...product.tags] } : null;
          }),
        },
        extensions: this.cost(Math.max(1, ids.length)),
      };
    }

    return {
      data: {
        nodes: ids.map((id) => {
          const variant = this.variants.get(id);
          // A deleted variant resolves to null, exactly as Shopify's `nodes` does.
          if (!variant || variant.deleted) return null;
          return { id, price: variant.price, compareAtPrice: variant.compareAtPrice };
        }),
      },
      extensions: this.cost(Math.max(1, ids.length)),
    };
  }

  /** Case-insensitive, and a no-op for a tag already present -- as Shopify behaves. */
  private tagsAdd(variables: Record<string, unknown>) {
    const id = String(variables.id ?? "");
    const tags = (variables.tags ?? []) as string[];
    const product = this.products.get(id);

    if (!product) {
      return {
        data: { tagsAdd: { node: null, userErrors: [{ field: ["id"], message: `Product ${id} does not exist.` }] } },
        extensions: this.cost(10),
      };
    }

    for (const tag of tags) {
      if (!product.tags.some((t) => t.toLowerCase() === tag.toLowerCase())) product.tags.push(tag);
    }

    return { data: { tagsAdd: { node: { id }, userErrors: [] } }, extensions: this.cost(10) };
  }

  private tagsRemove(variables: Record<string, unknown>) {
    const id = String(variables.id ?? "");
    const tags = ((variables.tags ?? []) as string[]).map((t) => t.toLowerCase());
    const product = this.products.get(id);

    if (!product) {
      return {
        data: { tagsRemove: { node: null, userErrors: [{ field: ["id"], message: `Product ${id} does not exist.` }] } },
        extensions: this.cost(10),
      };
    }

    product.tags = product.tags.filter((t) => !tags.includes(t.toLowerCase()));
    return { data: { tagsRemove: { node: { id }, userErrors: [] } }, extensions: this.cost(10) };
  }

  private stagedUploadsCreate() {
    const key = `staged/${++this.stagedSeq}`;
    return {
      data: {
        stagedUploadsCreate: {
          stagedTargets: [
            {
              url: this.blobs.uploadUrl(),
              resourceUrl: null,
              parameters: [
                { name: "key", value: key },
                { name: "Content-Type", value: "text/jsonl" },
              ],
            },
          ],
          userErrors: [],
        },
      },
      extensions: this.cost(10),
    };
  }

  private runBulkMutation(variables: Record<string, unknown>) {
    const path = String(variables.stagedUploadPath ?? "");
    const body = this.blobs.get(path);
    if (body === undefined) {
      return {
        data: {
          bulkOperationRunMutation: {
            bulkOperation: null,
            userErrors: [{ field: null, message: "Staged upload path not found." }],
          },
        },
        extensions: this.cost(10),
      };
    }

    this.bulkBody = body;
    this.bulkPolls = 0;
    this.bulk = { id: `gid://shopify/BulkOperation/${this.stagedSeq}`, status: "CREATED" };

    return {
      data: { bulkOperationRunMutation: { bulkOperation: this.bulk, userErrors: [] } },
      extensions: this.cost(10),
    };
  }

  /**
   * The poll endpoint, and the only place a bulk operation ever finishes.
   *
   * Deliberately not instant: a fake that completed on submission would let the poll
   * fallback pass without ever polling, which is the exact code path E13 is about.
   */
  private currentBulkOperation() {
    if (!this.bulk) {
      return { data: { currentBulkOperation: null }, extensions: this.cost(1) };
    }

    this.polls++;

    if (this.bulk.status === "CREATED" || this.bulk.status === "RUNNING") {
      this.bulkPolls++;
      this.bulk = { ...this.bulk, status: "RUNNING" };
      if (this.bulkPolls > this.pollsBeforeComplete) this.bulk = this.finishBulk();
    }

    return { data: { currentBulkOperation: this.bulk }, extensions: this.cost(1) };
  }

  /** Applies the uploaded JSONL and publishes a Shopify-shaped result file. */
  private finishBulk(): BulkOperationState {
    const lines = (this.bulkBody ?? "").split("\n").filter((line) => line.trim().length > 0);
    const results: string[] = [];

    lines.forEach((raw, index) => {
      const parsed = JSON.parse(raw) as {
        productId: string;
        variants: Array<Record<string, unknown>>;
      };
      const payload = this.applyVariantInputs(parsed.variants);
      const line: BulkResultLine = {
        __lineNumber: index + 1,
        data: { productVariantsBulkUpdate: payload },
      };
      results.push(JSON.stringify(line));
    });

    const url = this.blobs.put(`results/${this.stagedSeq}`, `${results.join("\n")}\n`);
    return {
      id: this.bulk!.id,
      status: "COMPLETED",
      url,
      objectCount: String(lines.length),
    };
  }
}
