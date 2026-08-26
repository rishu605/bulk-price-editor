/**
 * Per-market prices, and the compare-at the ecosystem thinks is impossible.
 *
 * The belief almost certainly comes from one wrong turn: the product-level mutation is
 * the obvious choice and its input has no compare-at field at all. Reach for it, find no
 * way to set a strike-through, conclude Shopify does not support it. The schema is
 * unambiguous —
 *
 *   PriceListProductPriceInput  { productId, price }
 *   PriceListPriceInput         { variantId, price, compareAtPrice }
 *
 * — so these tests pin the variant-level shape, the 250-per-request cap that makes
 * chunking mandatory, and the rule that silence about a row is not success.
 */

import { describe, expect, it, vi } from "vitest";

import { money } from "../money/money";
import {
  chunkPrices,
  deleteMarketPrices,
  MAX_PRICES_PER_REQUEST,
  MAX_VARIANTS_PER_PRICE_QUERY,
  readDerivedPrices,
  toPriceInput,
  writeMarketPrices,
  type MarketPriceRow,
} from "./market-executor";
import type { AdminClient } from "./sync-executor";

const row = (n: number, compareAt?: number): MarketPriceRow => ({
  variantGid: `gid://shopify/ProductVariant/${n}`,
  price: money(1_000 + n, "EUR"),
  ...(compareAt === undefined ? {} : { compareAt: money(compareAt, "EUR") }),
});

/** A price list that accepts everything and confirms it. */
function acceptingClient(seen: Array<Record<string, unknown>> = []): AdminClient {
  return {
    async request<T>(_query: string, variables: Record<string, unknown>) {
      seen.push(variables);
      const prices = ((variables.prices ?? []) as Array<{ variantId: string }>).map((p) => ({
        variant: { id: p.variantId },
      }));
      return { data: { priceListFixedPricesAdd: { prices, userErrors: [] } } as T };
    },
  };
}

describe("toPriceInput", () => {
  it("sends compare-at on the variant-level input", () => {
    // The capability the whole feature turns on.
    expect(toPriceInput(row(1, 2_000), "EUR")).toEqual({
      variantId: "gid://shopify/ProductVariant/1",
      price: { amount: "10.01", currencyCode: "EUR" },
      compareAtPrice: { amount: "20.00", currencyCode: "EUR" },
    });
  });

  it("omits compare-at entirely rather than sending null", () => {
    // On this surface a null compare-at is a different instruction from an absent one.
    // Sending null on every write would clear strike-throughs the merchant set.
    expect(toPriceInput(row(1), "EUR")).not.toHaveProperty("compareAtPrice");
  });

  it("carries the market's currency, not the shop's", () => {
    expect(toPriceInput(row(1), "JPY")).toMatchObject({
      price: { currencyCode: "JPY" },
    });
  });
});

describe("chunkPrices", () => {
  it("splits at Shopify's cap", () => {
    // Not a tuning knob: the request is rejected above it.
    expect(MAX_PRICES_PER_REQUEST).toBe(250);
    const chunks = chunkPrices(Array.from({ length: 601 }, (_, i) => i));
    expect(chunks.map((c) => c.length)).toEqual([250, 250, 101]);
  });

  it("returns nothing for nothing", () => {
    expect(chunkPrices([])).toEqual([]);
  });
});

describe("writeMarketPrices", () => {
  it("writes every row and reports it clean", async () => {
    const result = await writeMarketPrices(acceptingClient(), "gid://PriceList/1", "EUR", [
      row(1, 2_000),
      row(2),
    ]);

    expect(result.clean).toBe(true);
    expect(result.verified).toBe(2);
    expect(result.chunks).toBe(1);
  });

  it("sends one request per chunk, and no more", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const rows = Array.from({ length: 500 }, (_, i) => row(i));

    const result = await writeMarketPrices(acceptingClient(seen), "gid://PriceList/1", "EUR", rows);

    expect(seen).toHaveLength(2);
    expect(result.chunks).toBe(2);
    expect(result.verified).toBe(500);
  });

  it("does not count a row Shopify declined to confirm", async () => {
    // Silence about a row is the API not confirming it. Treating that as success is how
    // a half-applied market campaign gets reported complete.
    const partial: AdminClient = {
      async request<T>() {
        return {
          data: {
            priceListFixedPricesAdd: {
              prices: [{ variant: { id: "gid://shopify/ProductVariant/1" } }],
              userErrors: [],
            },
          } as T,
        };
      },
    };

    const result = await writeMarketPrices(partial, "gid://PriceList/1", "EUR", [row(1), row(2)]);
    expect(result.verified).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.clean).toBe(false);
    expect(result.rows.find((r) => r.variantGid.endsWith("/2"))?.failureReason).toMatch(/did not confirm/i);
  });

  it("maps a positional userError back to its own row", async () => {
    const rejecting: AdminClient = {
      async request<T>() {
        return {
          data: {
            priceListFixedPricesAdd: {
              prices: [{ variant: { id: "gid://shopify/ProductVariant/1" } }],
              userErrors: [{ field: ["prices", "1", "price"], message: "Price is invalid" }],
            },
          } as T,
        };
      },
    };

    const result = await writeMarketPrices(rejecting, "gid://PriceList/1", "EUR", [row(1), row(2)]);
    expect(result.rows.find((r) => r.variantGid.endsWith("/1"))?.status).toBe("verified");
    expect(result.rows.find((r) => r.variantGid.endsWith("/2"))?.failureReason).toContain("invalid");
  });

  it("fails only the chunk that threw, not the ones that landed", async () => {
    // One bad chunk must not discard 249 prices that were written successfully.
    let call = 0;
    const flaky: AdminClient = {
      async request<T>(_q: string, variables: Record<string, unknown>) {
        if (++call === 2) throw new Error("fetch failed");
        const prices = ((variables.prices ?? []) as Array<{ variantId: string }>).map((p) => ({
          variant: { id: p.variantId },
        }));
        return { data: { priceListFixedPricesAdd: { prices, userErrors: [] } } as T };
      },
    };

    const rows = Array.from({ length: 300 }, (_, i) => row(i));
    const result = await writeMarketPrices(flaky, "gid://PriceList/1", "EUR", rows);

    expect(result.verified).toBe(250);
    expect(result.failed).toBe(50);
  });

  it("reports each chunk as it goes, for the ledger", async () => {
    const onChunk = vi.fn();
    await writeMarketPrices(
      acceptingClient(),
      "gid://PriceList/1",
      "EUR",
      Array.from({ length: 300 }, (_, i) => row(i)),
      onChunk,
    );
    expect(onChunk).toHaveBeenCalledTimes(2);
  });
});

describe("deleteMarketPrices", () => {
  it("deletes rather than writing the old value back", async () => {
    // Deleting returns a variant to the list's parent adjustment. Writing a previous
    // value back would pin a price the merchant never chose and stop the list tracking
    // the base price at all.
    const seen: Array<Record<string, unknown>> = [];
    const client: AdminClient = {
      async request<T>(_q: string, variables: Record<string, unknown>) {
        seen.push(variables);
        return {
          data: {
            priceListFixedPricesDelete: {
              deletedFixedPriceVariantIds: variables.variantIds,
              userErrors: [],
            },
          } as T,
        };
      },
    };

    const result = await deleteMarketPrices(client, "gid://PriceList/1", ["gid://v/1", "gid://v/2"]);
    expect(result.clean).toBe(true);
    expect(seen[0].variantIds).toEqual(["gid://v/1", "gid://v/2"]);
  });

  it("treats a variant with no fixed price as already reverted", async () => {
    // It is already where a revert wants it. Reporting it as a failure would fill a
    // revert with errors nobody can act on.
    const client: AdminClient = {
      async request<T>() {
        return {
          data: { priceListFixedPricesDelete: { deletedFixedPriceVariantIds: [], userErrors: [] } } as T,
        };
      },
    };

    const result = await deleteMarketPrices(client, "gid://PriceList/1", ["gid://v/1"]);
    expect(result.clean).toBe(true);
    expect(result.verified).toBe(1);
  });

  it("chunks deletes at the same cap", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const client: AdminClient = {
      async request<T>(_q: string, variables: Record<string, unknown>) {
        seen.push(variables);
        return {
          data: {
            priceListFixedPricesDelete: {
              deletedFixedPriceVariantIds: variables.variantIds,
              userErrors: [],
            },
          } as T,
        };
      },
    };

    await deleteMarketPrices(client, "gid://PriceList/1", Array.from({ length: 260 }, (_, i) => `gid://v/${i}`));
    expect(seen).toHaveLength(2);
  });
});

describe("reading what a market currently derives", () => {
  /** A client that records what it was asked and answers from a fixture. */
  function reader(pages: Array<Record<string, unknown>>) {
    const queries: string[] = [];
    let call = 0;
    const client: AdminClient = {
      async request<T>(_query: string, variables: Record<string, unknown>) {
        queries.push(String(variables.query ?? ""));
        return { data: pages[Math.min(call++, pages.length - 1)] as T };
      },
    };
    return { client, queries };
  }

  const page = (
    nodes: Array<[string, string]>,
    next: string | null = null,
  ) => ({
    priceList: {
      currency: "JPY",
      prices: {
        nodes: nodes.map(([id, amount]) => ({
          variant: { id },
          price: { amount, currencyCode: "JPY" },
        })),
        pageInfo: { hasNextPage: next !== null, endCursor: next },
      },
    },
  });

  it("asks for the variants in scope by numeric id, not by gid", async () => {
    const { client, queries } = reader([page([["gid://shopify/ProductVariant/1", "1480"]])]);

    await readDerivedPrices(client, "gid://shopify/PriceList/jp", [
      "gid://shopify/ProductVariant/1",
      "gid://shopify/ProductVariant/2",
    ]);

    // The search syntax takes bare ids. Sending gids matches nothing and returns an
    // empty page, which reads exactly like "this market has no prices" -- so the
    // campaign would skip the market in silence rather than fail.
    expect(queries[0]).toBe("variant_id:1 OR variant_id:2");
  });

  it("follows pagination rather than stopping at the first page", async () => {
    const { client } = reader([
      page([["gid://shopify/ProductVariant/1", "1480"]], "cursor-1"),
      page([["gid://shopify/ProductVariant/2", "2960"]]),
    ]);

    const prices = await readDerivedPrices(client, "gid://shopify/PriceList/jp", [
      "gid://shopify/ProductVariant/1",
      "gid://shopify/ProductVariant/2",
    ]);

    expect(prices.size).toBe(2);
    expect(prices.get("gid://shopify/ProductVariant/2")).toEqual({
      amount: "2960",
      currency: "JPY",
    });
  });

  it("batches large scopes into several queries", async () => {
    const { client, queries } = reader([page([])]);
    const gids = Array.from(
      { length: MAX_VARIANTS_PER_PRICE_QUERY + 1 },
      (_, i) => `gid://shopify/ProductVariant/${i}`,
    );

    await readDerivedPrices(client, "gid://shopify/PriceList/jp", gids);

    expect(queries).toHaveLength(2);
    expect(queries[1]).toBe(`variant_id:${MAX_VARIANTS_PER_PRICE_QUERY}`);
  });

  it("omits a variant the market has no price for rather than inventing one", async () => {
    const { client } = reader([page([["gid://shopify/ProductVariant/1", "1480"]])]);

    const prices = await readDerivedPrices(client, "gid://shopify/PriceList/jp", [
      "gid://shopify/ProductVariant/1",
      "gid://shopify/ProductVariant/2",
    ]);

    // Absent, not zero and not the base price. A missing reference means the campaign
    // has nothing to compute against on this market, and the honest response is to
    // leave the variant unpriced there.
    expect(prices.has("gid://shopify/ProductVariant/2")).toBe(false);
  });

  it("keeps the currency Shopify stated, which is not always the list's", async () => {
    /**
     * The distinction that cost the most to find. `priceList.prices(originType: RELATIVE)`
     * answers in the **shop's** currency with the list's adjustment applied, while a
     * `FIXED` price on the same list answers in the list's own currency.
     *
     * On the store: a JPY list at -10% returned `{"amount":"18.0","currencyCode":"USD"}`
     * for a $20 variant, whose real market price is ¥2,921. Reading the amount and
     * assuming the list's currency recorded a baseline of ¥18 — wrong by the exchange
     * rate, on the surface a merchant is least able to check.
     *
     * So the currency travels with the amount, and the caller compares it rather than
     * assuming. Dropping it here is what let the mistake happen once already.
     */
    const { client } = reader([
      {
        priceList: {
          currency: "JPY",
          prices: {
            nodes: [
              {
                variant: { id: "gid://shopify/ProductVariant/1" },
                price: { amount: "18.0", currencyCode: "USD" },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    ]);

    const prices = await readDerivedPrices(client, "gid://shopify/PriceList/jp", [
      "gid://shopify/ProductVariant/1",
    ]);

    expect(prices.get("gid://shopify/ProductVariant/1")).toEqual({
      amount: "18.0",
      currency: "USD",
    });
  });

  it("drops a price with no stated currency rather than guessing one", async () => {
    // Guessing is the whole bug. A row left out goes down the ordinary write path, which
    // is the safe direction; a row guessed at goes to a storefront.
    const { client } = reader([
      {
        priceList: {
          currency: "JPY",
          prices: {
            nodes: [
              { variant: { id: "gid://shopify/ProductVariant/1" }, price: { amount: "18.0" } },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    ]);

    const prices = await readDerivedPrices(client, "gid://shopify/PriceList/jp", [
      "gid://shopify/ProductVariant/1",
    ]);

    expect(prices.size).toBe(0);
  });
});