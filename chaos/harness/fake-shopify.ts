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
import { minorUnitsPerMajor } from "../../app/lib/money/currency";
import { formatMoney, money, parseMoney } from "../../app/lib/money/money";
import type { BlobStore } from "./blob-store";

export interface FakeProduct {
  productGid: string;
  /** Shopify stores tags per product, and treats them case-insensitively. */
  tags: string[];
}

export interface FakePriceList {
  id: string;
  name: string;
  currency: string;
  /** Percentage adjustment, or null when the list stores fixed per-variant prices. */
  adjustment: { type: string; value: number } | null;
  catalog: { id: string; title: string; __typename: string } | null;
  /**
   * The country this list's market serves, if it has one.
   *
   * `contextualPricing` is asked by country rather than by price list, so this is how a
   * scenario says which market a shopper is in. Absent for a company-location catalogue,
   * which is priced by company and has no country at all.
   */
  country?: string;
  /**
   * Answer this market's contextual prices in a currency that is not the list's.
   *
   * Fault injection, not behaviour: a market should always answer in its own currency, and
   * the campaign refuses it when that is not true. Provable only by making it untrue, and
   * worth proving because a price in the wrong currency is the one kind of wrong price
   * that looks like an ordinary number — €797.36 where ¥797.36 would be absurd on sight.
   */
  answersInCurrency?: string;
  /** Per-variant entries, as Shopify reports them -- fixed and derived alike. */
  prices: Array<{
    variantGid: string;
    amount: string;
    compareAt: string | null;
    originType: "FIXED" | "RELATIVE";
  }>;
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

  /** Market and B2B price lists. */
  readonly priceLists: FakePriceList[] = [];

  /** The base price's currency. Market lists carry their own. */
  shopCurrency = "USD";

  /**
   * Exchange rates from the shop currency, per market currency.
   *
   * Present so the fake can derive a relative list's prices the way Shopify does:
   * convert first, adjust second. A fake that skipped the conversion would agree with
   * an app that also skipped it, and the two would be wrong together — which is the
   * failure mode a fake is supposed to make impossible.
   */
  readonly rates = new Map<string, number>([["EUR", 0.92], ["JPY", 148]]);

  /**
   * Every price this store accepted, and which surface it landed on.
   *
   * The surface is part of the record because I4 is per-surface: a variant with a
   * ledgered base price and an unledgered EUR price is still an unexplainable change
   * to somebody's storefront. Keying the check on the variant alone let the base row
   * vouch for the market write, which is the one case the market path could get wrong.
   */
  readonly writeLog: Array<{
    variantGid: string;
    price: string;
    priceListGid: string | null;
  }> = [];

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

  /**
   * The currency a surface prices in, so a reader can parse its amounts.
   *
   * Not a formality: "9312" is ¥9,312 on the Japanese list and $93.12 on the base
   * price. A reader that assumes two decimals is wrong by a factor of a hundred in
   * exactly the market this feature exists to serve.
   */
  currencyOf(priceListGid?: string | null): string {
    if (!priceListGid) return this.shopCurrency;
    return this.priceLists.find((l) => l.id === priceListGid)?.currency ?? this.shopCurrency;
  }

  /**
   * What a shopper pays, on the surface they are shopping.
   *
   * Without a price list this is the variant's own price. With one it is the fixed
   * price on that list -- and `undefined` if the list has none, because the shopper
   * then pays whatever the list's parent adjustment derives, which is by definition
   * not a price the campaign wrote.
   */
  priceOf(variantGid: string, priceListGid?: string | null): string | undefined {
    if (priceListGid) {
      const fixed = this.fixedPricesOn(priceListGid).get(variantGid)?.amount;
      if (fixed !== undefined) return fixed;

      // No fixed price does not mean no price. A market repriced by its parent
      // adjustment has no per-variant rows at all, and reading that as "the campaign
      // wrote nothing here" would let the whole market-wide path go unverified.
      const list = this.priceLists.find((l) => l.id === priceListGid);
      return list ? this.derivedPriceOf(variantGid, list) : undefined;
    }

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
    if (query.includes("priceListUpdate")) {
      return this.priceListUpdate(variables) as { data?: T; extensions?: { cost?: QueryCost } };
    }
    if (query.includes("fixed: prices(originType: FIXED")) {
      return this.priceListParent(variables) as { data?: T; extensions?: { cost?: QueryCost } };
    }
    // Matched on the operation name, not on a field name.
    //
    // The router works by substring, which is fine until a *comment* in another query
    // mentions the field — the markets sync explains why it needs a country, and doing so
    // sent the price-list query here and returned zero markets. An operation name cannot
    // collide by accident that way.
    if (query.includes("AnchorContextualPrices")) {
      return this.contextualPrices(variables) as { data?: T; extensions?: { cost?: QueryCost } };
    }
    if (query.includes("prices(originType: RELATIVE")) {
      return this.derivedPrices(variables) as { data?: T; extensions?: { cost?: QueryCost } };
    }
    if (query.includes("priceListFixedPricesAdd")) {
      return this.priceListFixedPricesAdd(variables) as { data?: T; extensions?: { cost?: QueryCost } };
    }
    if (query.includes("priceListFixedPricesDelete")) {
      return this.priceListFixedPricesDelete(variables) as { data?: T; extensions?: { cost?: QueryCost } };
    }
    if (query.includes("priceLists(")) {
      return this.listPriceLists() as { data?: T; extensions?: { cost?: QueryCost } };
    }
    if (query.includes("priceList(")) {
      return this.priceListPrices(variables) as { data?: T; extensions?: { cost?: QueryCost } };
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
        this.writeLog.push({ variantGid: id, price: input.price, priceListGid: null });
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

  addPriceList(list: FakePriceList): void {
    this.priceLists.push(list);
  }

  /** Fixed prices currently on a list, keyed by variant — what a shopper there sees. */
  fixedPricesOn(priceListGid: string): Map<string, { amount: string; compareAt: string | null }> {
    const list = this.priceLists.find((l) => l.id === priceListGid);
    const out = new Map<string, { amount: string; compareAt: string | null }>();
    for (const entry of list?.prices ?? []) {
      if (entry.originType === "FIXED") {
        out.set(entry.variantGid, { amount: entry.amount, compareAt: entry.compareAt });
      }
    }
    return out;
  }

  /**
   * What a relative list derives for a variant: converted, then adjusted, then rounded
   * to the target currency's precision.
   *
   * The order is Shopify's and it is not interchangeable. Adjusting before converting
   * gives a different number in every currency whose minor unit is not the shop's.
   */
  /**
   * A percentage applied to integer minor units.
   *
   * Basis points keep the multiplication integral so there is exactly one divide, and the
   * one divide is the one being rounded. The obvious spelling — `minor * (1 + value/100)`
   * and then a scale back through major units — turned 3517.5 into 3517.4999999999995 and
   * made two of this fake's own price functions disagree by a minor unit, which surfaced
   * as a chaos scenario reporting a verified row the store did not have. Rule 7 applies to
   * the harness as much as to the product.
   */
  private adjustMinorUnits(minorUnits: number, adjustment: { type: string; value: number }): number {
    const sign = adjustment.type === "PERCENTAGE_DECREASE" ? -1 : 1;
    const bps = 10_000 + sign * adjustment.value * 100;
    return Math.round((minorUnits * bps) / 10_000);
  }

  /**
   * What `priceList.prices(originType: RELATIVE)` really answers: the base price with the
   * list's adjustment applied, **in the shop's currency**, with no conversion at all.
   */
  relativePriceOf(variantGid: string, list: FakePriceList): string | undefined {
    const variant = this.variants.get(variantGid);
    if (!variant || variant.deleted || !list.adjustment) return undefined;

    const base = parseMoney(variant.price, this.shopCurrency).amount;

    return formatMoney(money(this.adjustMinorUnits(base, list.adjustment), this.shopCurrency));
  }

  derivedPriceOf(variantGid: string, list: FakePriceList): string | undefined {
    const variant = this.variants.get(variantGid);
    if (!variant || variant.deleted || !list.adjustment) return undefined;

    const inTarget = this.convertMinorUnits(
      parseMoney(variant.price, this.shopCurrency).amount,
      list.currency,
    );

    return formatMoney(money(this.adjustMinorUnits(inTarget, list.adjustment), list.currency));
  }

  /**
   * Shop minor units into a market's minor units, at that market's rate.
   *
   * The exponents differ as well as the rate: $77.60 is 7760 cents, and at 148 that is
   * ¥11,485 — 11485 minor units, not 1,148,480. Converting through major units is the only
   * way that arithmetic stays right, and it is why this is the one place a float is
   * unavoidable — an exchange rate is not a rational number we get to choose.
   */
  private convertMinorUnits(shopMinorUnits: number, currency: string): number {
    const rate = currency === this.shopCurrency ? 1 : (this.rates.get(currency) ?? 1);
    const major = (shopMinorUnits / minorUnitsPerMajor(this.shopCurrency)) * rate;

    return Math.round(major * minorUnitsPerMajor(currency));
  }

  /** Mutations that moved a whole market at once. Scenarios count these. */
  readonly parentWrites: Array<{ priceListGid: string; type: string; value: number }> = [];

  /** Serves the parent-adjustment read, including whether anything overrides it. */
  private priceListParent(variables: Record<string, unknown>) {
    const list = this.priceLists.find((l) => l.id === String(variables.id ?? ""));
    if (!list) return { data: { priceList: null }, extensions: this.cost(2) };

    return {
      data: {
        priceList: {
          id: list.id,
          currency: list.currency,
          parent: list.adjustment
            ? { adjustment: list.adjustment, settings: { compareAtMode: "ADJUSTED" } }
            : null,
          fixed: {
            nodes: list.prices
              .filter((entry) => entry.originType === "FIXED")
              .slice(0, 1)
              .map((entry) => ({ variant: { id: entry.variantGid } })),
          },
        },
      },
      extensions: this.cost(2),
    };
  }

  /** Sets a list's parent adjustment. Every derived price moves with it. */
  private priceListUpdate(variables: Record<string, unknown>) {
    const list = this.priceLists.find((l) => l.id === String(variables.id ?? ""));
    const input = (variables.input ?? {}) as {
      parent?: { adjustment?: { type?: string; value?: number } };
    };
    const adjustment = input.parent?.adjustment;

    if (!list || !adjustment?.type || typeof adjustment.value !== "number") {
      return {
        data: {
          priceListUpdate: {
            priceList: null,
            userErrors: [{ field: ["id"], message: "Price list does not exist." }],
          },
        },
        extensions: this.cost(10),
      };
    }

    list.adjustment = { type: adjustment.type, value: adjustment.value };

    // Every variant whose price this moved, logged as a write.
    //
    // One mutation, but N price changes on the storefront, and I4 does not care which
    // it was: no price may change without a ledger row behind it. Logging them all is
    // what makes a wrongly-granted market-wide shortcut fail the verdict automatically
    // -- the campaign ledgered its own variants, so the ones it never covered show up
    // as unexplainable changes, which is precisely what they are.
    for (const [gid, variant] of this.variants) {
      if (variant.deleted) continue;
      if (list.prices.some((p) => p.variantGid === gid && p.originType === "FIXED")) continue;

      const amount = this.derivedPriceOf(gid, list);
      if (amount) this.writeLog.push({ variantGid: gid, price: amount, priceListGid: list.id });
    }

    this.parentWrites.push({
      priceListGid: list.id,
      type: adjustment.type,
      value: adjustment.value,
    });

    return {
      data: {
        priceListUpdate: {
          priceList: { id: list.id, parent: { adjustment: list.adjustment } },
          userErrors: [],
        },
      },
      extensions: this.cost(10),
    };
  }

  /**
   * Serves `productVariant.contextualPricing(context: { country })`.
   *
   * What a shopper in that country pays, after everything: the base price converted at the
   * market's rate, the list's percentage applied, and any price the merchant set by hand
   * taking precedence over both — with its own compare-at, which is the per-market
   * strike-through the product exists for.
   *
   * This is the market surface's source of truth, because it is the only question whose
   * answer is a price rather than an ingredient. A price list's own connection gives
   * relative prices in the shop's currency (#257), and converting one ourselves is how a
   * JPY market ends up 146x out.
   */
  private contextualPrices(variables: Record<string, unknown>) {
    const ids = (variables.ids as string[] | undefined) ?? [];
    const country = String((variables.context as { country?: string } | undefined)?.country ?? "");
    const list = this.priceLists.find((l) => l.country === country);

    const nodes = ids.map((gid) => {
      const variant = this.variants.get(gid);
      if (!variant || variant.deleted) return null;

      // No market for this country: the shopper pays the shop's own price.
      if (!list) {
        return {
          id: gid,
          contextualPricing: {
            price: { amount: variant.price, currencyCode: this.shopCurrency },
            compareAtPrice: variant.compareAtPrice
              ? { amount: variant.compareAtPrice, currencyCode: this.shopCurrency }
              : null,
          },
        };
      }

      // A hand-set price wins over the list's percentage, which is what "fixed" means.
      const fixed = list.prices.find((p) => p.variantGid === gid && p.originType === "FIXED");
      if (fixed) {
        return {
          id: gid,
          contextualPricing: {
            price: { amount: fixed.amount, currencyCode: list.currency },
            compareAtPrice: fixed.compareAt
              ? { amount: fixed.compareAt, currencyCode: list.currency }
              : null,
          },
        };
      }

      const amount = this.derivedPriceOf(gid, list);
      if (!amount) return null;

      return {
        id: gid,
        contextualPricing: {
          price: { amount, currencyCode: list.answersInCurrency ?? list.currency },
          compareAtPrice: null,
        },
      };
    });

    return { data: { nodes }, extensions: this.cost(Math.max(1, ids.length)) };
  }

  /** Serves `priceList.prices(originType: RELATIVE)`, filtered by variant id. */
  private derivedPrices(variables: Record<string, unknown>) {
    const list = this.priceLists.find((l) => l.id === String(variables.priceListId ?? ""));
    const ids = new Set(
      String(variables.query ?? "")
        .split(" OR ")
        .map((term) => term.replace("variant_id:", "").trim())
        .filter(Boolean),
    );

    const nodes: Array<{ variant: { id: string }; price: { amount: string; currencyCode: string } }> = [];

    if (list) {
      for (const [gid, variant] of this.variants) {
        if (variant.deleted) continue;
        if (ids.size > 0 && !ids.has(gid.split("/").pop() ?? "")) continue;
        // A variant with a fixed price on this list has no relative price -- its origin
        // is FIXED, so it is not in this connection at all.
        if (list.prices.some((p) => p.variantGid === gid && p.originType === "FIXED")) continue;

        // In the shop's currency, which is what the real API does: a JPY list at -10%
        // answers `{"amount":"18.0","currencyCode":"USD"}` for a $20 variant, and the
        // conversion into the market's currency happens later at presentment. This fake
        // answered in the list's currency, so the production code and the fake agreed with
        // each other and neither agreed with Shopify (#257).
        const amount = this.relativePriceOf(gid, list);
        if (amount) {
          nodes.push({
            variant: { id: gid },
            price: { amount, currencyCode: this.shopCurrency },
          });
        }
      }
    }

    return {
      data: {
        priceList: list
          ? { currency: list.currency, prices: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } }
          : null,
      },
      extensions: this.cost(5),
    };
  }

  /**
   * Add-and-replace, as Shopify documents it, and capped.
   *
   * The cap is enforced rather than assumed: a fake that silently accepted 400 prices
   * would let a chunking bug through and the first real store would find it.
   */
  private priceListFixedPricesAdd(variables: Record<string, unknown>) {
    const list = this.priceLists.find((l) => l.id === String(variables.priceListId ?? ""));
    const prices = (variables.prices ?? []) as Array<{
      variantId: string;
      price: { amount: string };
      compareAtPrice?: { amount: string } | null;
    }>;

    if (!list) {
      return {
        data: {
          priceListFixedPricesAdd: {
            prices: [],
            userErrors: [{ field: ["priceListId"], message: "Price list does not exist." }],
          },
        },
        extensions: this.cost(10),
      };
    }

    if (prices.length > 250) {
      return {
        data: {
          priceListFixedPricesAdd: {
            prices: [],
            userErrors: [{ field: ["prices"], message: "Cannot set more than 250 prices per request." }],
          },
        },
        extensions: this.cost(10),
      };
    }

    const confirmed: Array<{ variant: { id: string } }> = [];

    for (const price of prices) {
      const existing = list.prices.findIndex((entry) => entry.variantGid === price.variantId);
      const row = {
        variantGid: price.variantId,
        amount: price.price.amount,
        compareAt: price.compareAtPrice?.amount ?? null,
        originType: "FIXED" as const,
      };

      if (existing === -1) list.prices.push(row);
      else list.prices[existing] = row;

      this.writeLog.push({
        variantGid: price.variantId,
        price: price.price.amount,
        priceListGid: list.id,
      });
      confirmed.push({ variant: { id: price.variantId } });
    }

    return {
      data: { priceListFixedPricesAdd: { prices: confirmed, userErrors: [] } },
      extensions: this.cost(10 * Math.max(1, prices.length)),
    };
  }

  /** Deleting a fixed price returns the variant to the list's parent adjustment. */
  private priceListFixedPricesDelete(variables: Record<string, unknown>) {
    const list = this.priceLists.find((l) => l.id === String(variables.priceListId ?? ""));
    const ids = new Set((variables.variantIds ?? []) as string[]);
    const deleted: string[] = [];

    if (list) {
      list.prices = list.prices.filter((entry) => {
        const remove = entry.originType === "FIXED" && ids.has(entry.variantGid);
        if (remove) deleted.push(entry.variantGid);
        return !remove;
      });
    }

    return {
      data: { priceListFixedPricesDelete: { deletedFixedPriceVariantIds: deleted, userErrors: [] } },
      extensions: this.cost(10),
    };
  }

  private listPriceLists() {
    return {
      data: {
        priceLists: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: this.priceLists.map((list) => ({
            id: list.id,
            name: list.name,
            currency: list.currency,
            parent: list.adjustment ? { adjustment: list.adjustment } : null,
            // The catalogue carries its market's region, because that is where the market
            // surface gets the country it asks `contextualPricing` about. A catalogue with
            // no country is a company-location catalogue, which has no market and no
            // region — and answering `markets: { nodes: [] }` for it is the truth, not an
            // omission.
            catalog: list.catalog
              ? {
                  ...list.catalog,
                  markets: {
                    nodes: list.country
                      ? [
                          {
                            conditions: {
                              regionsCondition: { regions: { nodes: [{ code: list.country }] } },
                            },
                          },
                        ]
                      : [],
                  },
                }
              : null,
          })),
        },
      },
      extensions: this.cost(10),
    };
  }

  /**
   * Prices on one list.
   *
   * Returns derived entries alongside fixed ones, as the real API does — that mixture
   * is the whole reason the mirror has to look at `originType` rather than storing
   * whatever it is handed.
   */
  private priceListPrices(variables: Record<string, unknown>) {
    const list = this.priceLists.find((l) => l.id === String(variables.id ?? ""));
    if (!list) return { data: { priceList: null }, extensions: this.cost(1) };

    return {
      data: {
        priceList: {
          id: list.id,
          prices: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: list.prices.map((entry) => ({
              originType: entry.originType,
              variant: { id: entry.variantGid },
              price: { amount: entry.amount, currencyCode: list.currency },
              compareAtPrice: entry.compareAt
                ? { amount: entry.compareAt, currencyCode: list.currency }
                : null,
            })),
          },
        },
      },
      extensions: this.cost(5),
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
