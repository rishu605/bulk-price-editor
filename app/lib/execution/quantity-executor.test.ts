/**
 * Writing wholesale ladders.
 *
 * Two things distinguish this surface. The mutation is all-or-nothing, so a failing chunk
 * fails every row in it — including the ones Shopify did not name. And a ladder that was
 * accepted is not a ladder that was stored, which is the lesson the base and market
 * surfaces learned the hard way.
 */

import { describe, expect, it } from "vitest";

import { money } from "../money/money";
import {
  chunkQuantityRows,
  LADDER_READ_VARIANTS,
  ladderReadCost,
  ladderReadsFor,
  MAX_SINGLE_QUERY_COST,
  readBaselineLadders,
  readLadders,
  writeQuantityBreaks,
  type QuantityRow,
} from "./quantity-executor";

const gbp = (minor: number) => money(minor, "GBP");

const row = (n: number): QuantityRow => ({
  variantGid: `gid://shopify/ProductVariant/${n}`,
  breaks: [
    { minimumQuantity: 1, price: gbp(4000) },
    { minimumQuantity: 12, price: gbp(3600) },
  ],
});

/** A price list that stores exactly what it is told and reads it back. */
function honestClient(sent: Array<Record<string, unknown>> = []) {
  const stored = new Map<string, Array<{ minimumQuantity: number; price: { amount: string } }>>();

  return {
    sent,
    async request<T>(query: string, variables: Record<string, unknown>) {
      if (query.includes("quantityPricingByVariantUpdate")) {
        sent.push(variables);
        const input = variables.input as {
          quantityPriceBreaksToAdd: Array<{
            variantId: string;
            minimumQuantity: number;
            price: { amount: string };
          }>;
          quantityPriceBreaksToDeleteByVariantId: string[];
        };

        for (const id of input.quantityPriceBreaksToDeleteByVariantId) stored.delete(id);
        for (const tier of input.quantityPriceBreaksToAdd) {
          const list = stored.get(tier.variantId) ?? [];
          list.push({ minimumQuantity: tier.minimumQuantity, price: { amount: tier.price.amount } });
          stored.set(tier.variantId, list);
        }

        const ids = [...new Set(input.quantityPriceBreaksToAdd.map((t) => t.variantId))];
        return {
          data: {
            quantityPricingByVariantUpdate: {
              productVariants: ids.map((id) => ({ id })),
              userErrors: [],
            },
          } as T,
        };
      }

      return {
        data: {
          priceList: {
            prices: {
              nodes: [...stored.entries()].map(([id, breaks]) => ({
                variant: { id },
                quantityPriceBreaks: { nodes: breaks },
              })),
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        } as T,
      };
    },
  };
}

describe("writing a ladder", () => {
  it("writes and verifies every row", async () => {
    const result = await writeQuantityBreaks(honestClient(), "gid://PriceList/1", [row(1), row(2)]);

    expect(result.clean).toBe(true);
    expect(result.verified).toBe(2);
    expect(result.failed).toBe(0);
  });

  it("replaces the existing ladder rather than adding to it", async () => {
    // Appending would leave last month's tier under this month's, and a buyer would get
    // whichever Shopify preferred.
    const client = honestClient();
    await writeQuantityBreaks(client, "gid://PriceList/1", [row(1)]);

    const input = client.sent[0]!.input as { quantityPriceBreaksToDeleteByVariantId: string[] };
    expect(input.quantityPriceBreaksToDeleteByVariantId).toContain(row(1).variantGid);
  });

  it("sends money as a decimal string in the tier's own currency", async () => {
    const client = honestClient();
    await writeQuantityBreaks(client, "gid://PriceList/1", [row(1)]);

    const input = client.sent[0]!.input as {
      quantityPriceBreaksToAdd: Array<{ price: { amount: string; currencyCode: string } }>;
    };
    expect(input.quantityPriceBreaksToAdd[0]!.price).toEqual({ amount: "40.00", currencyCode: "GBP" });
  });

  it("chunks so one request stays one transaction", () => {
    const rows = Array.from({ length: 250 }, (_, i) => row(i));

    expect(chunkQuantityRows(rows).map((c) => c.length)).toEqual([100, 100, 50]);
  });
});

describe("the mutation is all-or-nothing, and the ledger has to say so", () => {
  it("fails every row in a rejected chunk, not just the named one", async () => {
    const rejecting = {
      async request<T>() {
        return {
          data: {
            quantityPricingByVariantUpdate: {
              productVariants: [],
              userErrors: [
                { field: ["input", "quantityPriceBreaksToAdd", "3"], message: "Price is invalid" },
              ],
            },
          } as T,
        };
      },
    };

    const result = await writeQuantityBreaks(rejecting, "gid://PriceList/1", [row(1), row(2), row(3)]);

    // Attributing it to one row would imply the other two landed. They did not.
    expect(result.failed).toBe(3);
    expect(result.verified).toBe(0);
    expect(result.clean).toBe(false);
    expect(result.rows[0]!.guidance).toMatch(/applied none of it/);
  });

  it("fails every row in a chunk that threw", async () => {
    const broken = {
      async request<T>(): Promise<{ data?: T }> {
        throw new Error("fetch failed");
      },
    };

    const result = await writeQuantityBreaks(broken, "gid://PriceList/1", [row(1), row(2)]);

    expect(result.failed).toBe(2);
    expect(result.rows.every((r) => r.failureReason === "fetch failed")).toBe(true);
  });
});

describe("accepted is not the same as stored", () => {
  /** A price list that rounds every stored tier down to a whole unit and says nothing. */
  function roundingClient() {
    const honest = honestClient();
    return {
      async request<T>(query: string, variables: Record<string, unknown>) {
        if (query.includes("quantityPricingByVariantUpdate")) {
          const input = variables.input as {
            quantityPriceBreaksToAdd: Array<{ price: { amount: string } }>;
          };
          for (const tier of input.quantityPriceBreaksToAdd) {
            tier.price.amount = `${Math.floor(Number(tier.price.amount))}.00`;
          }
        }
        return honest.request<T>(query, variables);
      },
    };
  }

  it("refuses a ladder the price list quietly reshaped", async () => {
    const result = await writeQuantityBreaks(roundingClient(), "gid://PriceList/1", [
      {
        variantGid: "gid://shopify/ProductVariant/9",
        breaks: [{ minimumQuantity: 12, price: gbp(3650) }],
      },
    ]);

    expect(result.clean).toBe(false);
    expect(result.rows[0]!.failureReason).toMatch(/Read-back mismatch/);
    expect(result.rows[0]!.failureReason).toContain("12+");
  });

  it("refuses when the ladder came back a different length", async () => {
    const dropping = {
      async request<T>(query: string) {
        if (query.includes("quantityPricingByVariantUpdate")) {
          return {
            data: {
              quantityPricingByVariantUpdate: {
                productVariants: [{ id: row(1).variantGid }],
                userErrors: [],
              },
            } as T,
          };
        }
        return {
          data: {
            priceList: {
              prices: {
                nodes: [
                  {
                    variant: { id: row(1).variantGid },
                    quantityPriceBreaks: { nodes: [{ minimumQuantity: 1, price: { amount: "40.00" } }] },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          } as T,
        };
      },
    };

    const result = await writeQuantityBreaks(dropping, "gid://PriceList/1", [row(1)]);

    expect(result.rows[0]!.status).toBe("failed");
    expect(result.rows[0]!.failureReason).toMatch(/wrote 2 quantity breaks.*holds 1/);
  });

  it("does not call a row wrong just because the read failed", async () => {
    // "We could not check" is a weaker claim than "it is wrong", and reporting the
    // second would send a merchant looking for a problem that may not exist.
    const readFails = {
      async request<T>(query: string, variables: Record<string, unknown>) {
        if (query.includes("quantityPricingByVariantUpdate")) {
          return honestClient().request<T>(query, variables);
        }
        throw new Error("read timed out");
      },
    };

    const result = await writeQuantityBreaks(readFails, "gid://PriceList/1", [row(1)]);

    expect(result.rows[0]!.status).toBe("verified");
  });
});

describe("clearing a ladder", () => {
  /** A price list that acknowledges the delete and then keeps the ladder anyway. */
  function ignoresDeletes() {
    return {
      async request<T>(query: string) {
        if (query.includes("quantityPricingByVariantUpdate")) {
          return {
            data: {
              quantityPricingByVariantUpdate: { productVariants: [], userErrors: [] },
            } as T,
          };
        }
        return {
          data: {
            priceList: {
              prices: {
                nodes: [
                  {
                    variant: { id: row(1).variantGid },
                    quantityPriceBreaks: {
                      nodes: [{ minimumQuantity: 12, price: { amount: "36.00" } }],
                    },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          } as T,
        };
      },
    };
  }

  const clearing: QuantityRow = { variantGid: row(1).variantGid, breaks: [] };

  it("succeeds by the ladder being gone", async () => {
    const result = await writeQuantityBreaks(honestClient(), "gid://PriceList/1", [clearing]);

    expect(result.clean).toBe(true);
    expect(result.verified).toBe(1);
  });

  it("is not called done just because the mutation returned no errors", async () => {
    // A clearing row adds nothing, so the mutation names no variant for it. Confirmation
    // cannot speak to it either way — only the read-back can, and it has to.
    const result = await writeQuantityBreaks(ignoresDeletes(), "gid://PriceList/1", [clearing]);

    expect(result.clean).toBe(false);
    expect(result.rows[0]!.failureReason).toMatch(/asked for no quantity breaks.*still holds 1/);
    expect(result.rows[0]!.guidance).toMatch(/still live/);
  });

  it("asks Shopify to delete the variant's breaks", async () => {
    const client = honestClient();
    await writeQuantityBreaks(client, "gid://PriceList/1", [clearing]);

    const input = client.sent[0]!.input as {
      quantityPriceBreaksToDeleteByVariantId: string[];
      quantityPriceBreaksToAdd: unknown[];
    };
    expect(input.quantityPriceBreaksToDeleteByVariantId).toEqual([clearing.variantGid]);
    expect(input.quantityPriceBreaksToAdd).toEqual([]);
  });
});

describe("reading the ladders a catalogue already holds", () => {
  /**
   * The same read serves two purposes: checking what a run just wrote, and capturing what
   * a catalogue had before a campaign touched it. A ladder observed after the write and
   * one observed before it are the same kind of fact, so there is one implementation.
   */
  function listWith(nodes: unknown[], pages = 1) {
    let page = 0;
    return {
      async request<T>() {
        page += 1;
        return {
          data: {
            priceList: {
              prices: {
                nodes: page === 1 ? nodes : [],
                pageInfo: { hasNextPage: page < pages, endCursor: `cursor-${page}` },
              },
            },
          } as T,
        };
      },
    };
  }

  it("returns the rungs for the variants asked about", async () => {
    const client = listWith([
      {
        variant: { id: "gid://v/1" },
        quantityPriceBreaks: {
          nodes: [
            { minimumQuantity: 12, price: { amount: "36.00" } },
            { minimumQuantity: 1, price: { amount: "40.00" } },
          ],
        },
      },
    ]);

    const ladders = await readLadders(client, "gid://PriceList/1", ["gid://v/1"]);

    // Sorted, whatever order the connection returned them in.
    expect(ladders.get("gid://v/1")).toEqual([
      { minimumQuantity: 1, amount: "40.00" },
      { minimumQuantity: 12, amount: "36.00" },
    ]);
  });

  it("ignores variants nobody asked about", async () => {
    const client = listWith([
      {
        variant: { id: "gid://v/999" },
        quantityPriceBreaks: { nodes: [{ minimumQuantity: 1, price: { amount: "40.00" } }] },
      },
    ]);

    expect(await readLadders(client, "gid://PriceList/1", ["gid://v/1"])).toEqual(new Map());
  });

  it("leaves out a variant with no breaks rather than recording an empty ladder", async () => {
    // "No breaks" is the absence of an entry here, and null in the baseline column. Two
    // encodings of one state is how a query ends up missing rows.
    const client = listWith([
      { variant: { id: "gid://v/1" }, quantityPriceBreaks: { nodes: [] } },
    ]);

    expect(await readLadders(client, "gid://PriceList/1", ["gid://v/1"]).then((m) => m.size)).toBe(0);
  });

  it("follows pagination rather than reading only the first page", async () => {
    let pages = 0;
    const client = {
      async request<T>() {
        pages += 1;
        return {
          data: {
            priceList: {
              prices: { nodes: [], pageInfo: { hasNextPage: pages < 3, endCursor: `c${pages}` } },
            },
          } as T,
        };
      },
    };

    await readLadders(client, "gid://PriceList/1", ["gid://v/1"]);
    expect(pages).toBe(3);
  });

  // What a baseline records, for the campaign's capture and the sync's alike (#1071).
  describe("as a baseline records them", () => {
    it("takes integer minor units in the list's currency, a zero-decimal one included", async () => {
      const client = listWith([
        { variant: { id: "gid://v/1" }, quantityPriceBreaks: { nodes: [{ minimumQuantity: 12, price: { amount: "36.50" } }] } },
      ]);
      const yen = listWith([
        { variant: { id: "gid://v/1" }, quantityPriceBreaks: { nodes: [{ minimumQuantity: 12, price: { amount: "3650" } }] } },
      ]);

      expect(await readBaselineLadders(client, "gid://PriceList/1", "USD", ["gid://v/1"])).toEqual(
        new Map([["gid://v/1", [{ minimumQuantity: 12, price: money(3_650, "USD") }]]]),
      );
      expect(await readBaselineLadders(yen, "gid://PriceList/1", "JPY", ["gid://v/1"])).toEqual(
        new Map([["gid://v/1", [{ minimumQuantity: 12, price: money(3_650, "JPY") }]]]),
      );
    });

    it("leaves out a ladder that does not parse, which is no ladder, never half of one", async () => {
      const client = listWith([
        {
          variant: { id: "gid://v/1" },
          quantityPriceBreaks: { nodes: [{ minimumQuantity: 12, price: { amount: "36.00" } }, { minimumQuantity: 12, price: { amount: "30.00" } }] },
        },
      ]);

      expect(await readBaselineLadders(client, "gid://PriceList/1", "USD", ["gid://v/1"])).toEqual(new Map());
    });

    it("throws when Shopify cannot be read, rather than answering that there are no ladders", async () => {
      const client = {
        async request<T>(): Promise<{ data?: T }> {
          throw new Error("Service Unavailable");
        },
      };

      await expect(readBaselineLadders(client, "gid://PriceList/1", "USD", ["gid://v/1"])).rejects.toThrow(/Service Unavailable/);
    });
  });
});

/**
 * A wholesale catalogue as Shopify serves it (#704): one price per variant, relative ones
 * included, paged by `first` and `after`, searchable by `variant_id`, each price's rungs paged
 * the same way -- and a query over Shopify's single-query cost refused before it runs.
 */
function shopifyList(ladders: ReadonlyMap<number, Array<{ minimumQuantity: number; amount: string }>>, size: number) {
  const ids = Array.from({ length: size }, (_, n) => n + 1);
  const requests: Array<Record<string, unknown>> = [];

  /** Shopify's requested cost: an object is 1, a connection 2 plus `first` times its node. */
  const requestedCost = (query: string, first: number, rungs: number) => {
    const rungPageInfo = /quantityPriceBreaks\([^)]*\)\s*{[^}]*}[^}]*pageInfo/.test(query) ? 1 : 0;
    return 1 + 2 + first * (1 + 1 + (2 + rungs * 2) + rungPageInfo) + 1;
  };
  const literal = (query: string, field: string) => Number(new RegExp(`${field}\\([^)]*first:\\s*(\\d+)`).exec(query)?.[1]);

  return {
    requests,
    async request<T>(query: string, variables: Record<string, unknown>) {
      requests.push(variables);
      const first = Number(variables.first ?? literal(query, "prices"));
      const rungs = Number(variables.rungs ?? literal(query, "quantityPriceBreaks"));
      const cost = requestedCost(query, first, rungs);
      if (cost > 1_000 || first > 250 || rungs > 250) {
        throw new Error(`Query cost is ${cost}, which exceeds the single query max cost limit (1000).`);
      }

      const searched = typeof variables.query === "string" && variables.query
        ? new Set(variables.query.split(" OR ").map((term) => Number(term.replace("variant_id:", ""))))
        : null;
      const matching = ids.filter((id) => !searched || searched.has(id));
      const from = variables.after ? Number(variables.after) : 0;
      const page = matching.slice(from, from + first);
      const rungsFrom = variables.rungsAfter ? Number(variables.rungsAfter) : 0;

      return {
        data: {
          priceList: {
            prices: {
              nodes: page.map((id) => {
                const ladder = ladders.get(id) ?? [];
                const shown = ladder.slice(rungsFrom, rungsFrom + rungs);
                return {
                  variant: { id: `gid://shopify/ProductVariant/${id}` },
                  quantityPriceBreaks: {
                    nodes: shown.map((rung) => ({ minimumQuantity: rung.minimumQuantity, price: { amount: rung.amount, currencyCode: "USD" } })),
                    pageInfo: {
                      hasNextPage: rungsFrom + rungs < ladder.length,
                      endCursor: String(rungsFrom + shown.length),
                    },
                  },
                };
              }),
              pageInfo: { hasNextPage: from + first < matching.length, endCursor: String(from + page.length) },
            },
          },
        } as T,
      };
    },
  };
}

const variant = (n: number) => `gid://shopify/ProductVariant/${n}`;

describe("reading the ladders of a catalogue over 5,000 prices (#704)", () => {
  const LADDER = [
    { minimumQuantity: 12, amount: "36.00" },
    { minimumQuantity: 48, amount: "32.00" },
  ];

  it("finds a ladder past the list's 5,000th price", async () => {
    const client = shopifyList(new Map([[5_500, LADDER], [10, LADDER]]), 5_600);

    const ladders = await readLadders(client, "gid://PriceList/1", [variant(10), variant(5_500)]);

    expect(ladders.get(variant(10)), "a ladder near the start of the list was not read").toEqual(LADDER);
    expect(ladders.get(variant(5_500)), "a ladder past the 5,000th price was recorded as none").toEqual(LADDER);
  });

  it("asks Shopify about the variants it wants, not the whole list", async () => {
    const client = shopifyList(new Map([[5_500, LADDER]]), 5_600);

    await readLadders(client, "gid://PriceList/1", [variant(3), variant(2_000), variant(5_500)]);

    expect(client.requests, "three variants cost more than one read").toHaveLength(1);
    expect(client.requests[0]!.query).toBe("variant_id:3 OR variant_id:2000 OR variant_id:5500");
  });

  it("reads many variants a batch at a time, every batch within Shopify's cost limit", async () => {
    const wanted = Array.from({ length: 60 }, (_, n) => n * 90 + 1);
    const client = shopifyList(new Map(wanted.map((id) => [id, LADDER])), 5_600);

    const ladders = await readLadders(client, "gid://PriceList/1", wanted.map(variant));

    expect(ladders.size).toBe(60);
    expect(client.requests).toHaveLength(Math.ceil(60 / LADDER_READ_VARIANTS));
    expect(ladderReadCost(LADDER_READ_VARIANTS, 5)).toBeLessThanOrEqual(MAX_SINGLE_QUERY_COST);
  });

  it("says how many variants it has asked about after each read, for a recapture the page follows (#1105)", async () => {
    const wanted = Array.from({ length: 60 }, (_, n) => n * 90 + 1);
    const client = shopifyList(new Map(wanted.map((id) => [id, LADDER])), 5_600);
    const heard: number[] = [];

    await readLadders(client, "gid://PriceList/1", wanted.map(variant), (asked) => {
      heard.push(asked);
    });

    expect(heard).toEqual([LADDER_READ_VARIANTS, LADDER_READ_VARIANTS * 2, 60]);
  });

  it("follows a ladder longer than one read carries to its last rung", async () => {
    const long = Array.from({ length: 12 }, (_, n) => ({ minimumQuantity: (n + 1) * 10, amount: `${50 - n}.00` }));
    const client = shopifyList(new Map([[7, long], [8, LADDER]]), 20);

    const ladders = await readLadders(client, "gid://PriceList/1", [variant(7), variant(8)]);

    expect(ladders.get(variant(7)), "a long ladder was cut short").toEqual(long);
    expect(ladders.get(variant(8))).toEqual(LADDER);
  });

  it("counts the reads a capture of wholesale prices takes, by list", () => {
    expect(ladderReadsFor([])).toBe(0);
    expect(ladderReadsFor([1])).toBe(1);
    expect(ladderReadsFor([LADDER_READ_VARIANTS, LADDER_READ_VARIANTS + 1, 3])).toBe(4);
  });
});
