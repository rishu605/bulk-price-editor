import { describe, expect, it, vi } from "vitest";

import { money } from "../money/money";
import type { PlannedRow, SurfaceRef } from "../planning/types";
import { RateLimitBudget, isThrottledError, withRetry } from "../shopify/budget";
import {
  executeSync,
  indexFromField,
  toVariantInput,
  type AdminClient,
} from "./sync-executor";

const usd = (n: number) => money(n, "USD");
const noSleep = async () => {};

const ref = (variantGid: string): SurfaceRef => ({
  variantGid,
  surfaceKind: "base",
  priceListGid: "",
  currency: "USD",
});

function row(over: Partial<PlannedRow> = {}): PlannedRow {
  return {
    ref: ref("gid://shopify/ProductVariant/1"),
    beforePrice: usd(10_000),
    intendedPrice: usd(8_000),
    intendedCompareAtSet: false,
    status: "pending",
    ...over,
  };
}

/** Product mapping: variants 1-2 belong to product A, 3 to product B. */
const productOf = (gid: string) =>
  gid.endsWith("/3") ? "gid://shopify/Product/B" : "gid://shopify/Product/A";

interface FakeOptions {
  userErrors?: Array<{ field?: string[] | null; message: string; code?: string | null }>;
  /** Price the read-back reports, keyed by variant gid. Defaults to what was sent. */
  readBack?: Record<string, string>;
  throwTimes?: number;
  throwWith?: unknown;
}

function fakeClient(options: FakeOptions = {}) {
  const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
  const written = new Map<string, string>();
  let thrown = 0;

  const client: AdminClient = {
    async request<T>(query: string, variables: Record<string, unknown>) {
      calls.push({ query, variables });

      if (options.throwTimes && thrown < options.throwTimes) {
        thrown++;
        throw options.throwWith ?? { extensions: { code: "THROTTLED" }, message: "Throttled" };
      }

      if (query.includes("productVariantsBulkUpdate")) {
        const variants = variables.variants as Array<{ id: string; price?: string }>;
        for (const v of variants) if (v.price) written.set(v.id, v.price);
        return {
          data: {
            productVariantsBulkUpdate: {
              productVariants: variants.map((v) => ({
                id: v.id,
                price: v.price ?? "0",
                compareAtPrice: null,
              })),
              userErrors: options.userErrors ?? [],
            },
          } as T,
          extensions: {
            cost: {
              actualQueryCost: 100,
              throttleStatus: {
                maximumAvailable: 1_000,
                currentlyAvailable: 900,
                restoreRate: 50,
              },
            },
          },
        };
      }

      // Read-back
      const ids = variables.ids as string[];
      return {
        data: {
          nodes: ids.map((id) => ({
            id,
            price: options.readBack?.[id] ?? written.get(id) ?? "0",
            compareAtPrice: null,
          })),
        } as T,
      };
    },
  };

  return { client, calls, written };
}

function budget() {
  return new RateLimitBudget({ now: () => 0, sleep: noSleep });
}

describe("variant input", () => {
  it("sends only the fields the campaign decided on", () => {
    expect(toVariantInput(row())).toEqual({
      id: "gid://shopify/ProductVariant/1",
      price: "80.00",
    });
  });

  it("omits compareAtPrice entirely when the policy is leave-alone", () => {
    // Sending null unconditionally would wipe every merchant's compare-at on any
    // price change.
    const input = toVariantInput(row({ intendedCompareAtSet: false }));
    expect(input).not.toHaveProperty("compareAtPrice");
  });

  it("sends null to clear, and a value to set", () => {
    expect(
      toVariantInput(row({ intendedCompareAtSet: true, intendedCompareAt: null })),
    ).toMatchObject({ compareAtPrice: null });

    expect(
      toVariantInput(row({ intendedCompareAtSet: true, intendedCompareAt: usd(12_000) })),
    ).toMatchObject({ compareAtPrice: "120.00" });
  });
});

describe("grouping", () => {
  it("issues one mutation per product, not per variant", () => {
    // A per-variant loop multiplies request count by the average variant count.
    const { client, calls } = fakeClient();
    return executeSync(
      [
        row({ ref: ref("gid://shopify/ProductVariant/1") }),
        row({ ref: ref("gid://shopify/ProductVariant/2") }),
        row({ ref: ref("gid://shopify/ProductVariant/3") }),
      ],
      { client, budget: budget(), productOf, random: () => 0, sleep: noSleep },
    ).then(() => {
      const mutations = calls.filter((c) => c.query.includes("productVariantsBulkUpdate"));
      expect(mutations).toHaveLength(2);
      expect((mutations[0].variables.variants as unknown[]).length).toBe(2);
      expect((mutations[1].variables.variants as unknown[]).length).toBe(1);
    });
  });

  it("passes skipped rows through without writing them", async () => {
    const { client, calls } = fakeClient();
    const result = await executeSync(
      [row({ status: "skipped", intendedPrice: undefined, reason: "below-floor" })],
      { client, budget: budget(), productOf, random: () => 0, sleep: noSleep },
    );
    expect(calls).toHaveLength(0);
    expect(result.clean).toBe(true);
    expect(result.rows[0].status).toBe("verified");
  });
});

describe("userErrors mapping", () => {
  it("maps a positional userError back to the row it concerns", async () => {
    // Shopify returns HTTP 200 with userErrors -- treating that as success is the
    // silent-failure mode the ledger exists to prevent.
    const { client } = fakeClient({
      userErrors: [
        { field: ["variants", "1", "price"], message: "Price must be positive", code: "INVALID" },
      ],
    });

    const result = await executeSync(
      [
        row({ ref: ref("gid://shopify/ProductVariant/1") }),
        row({ ref: ref("gid://shopify/ProductVariant/2") }),
      ],
      { client, budget: budget(), productOf, verifySampleRate: 1, random: () => 0, sleep: noSleep },
    );

    const first = result.rows.find((r) => r.row.ref.variantGid.endsWith("/1"))!;
    const second = result.rows.find((r) => r.row.ref.variantGid.endsWith("/2"))!;

    expect(first.status).toBe("verified");
    expect(second.status).toBe("failed");
    expect(second.failureReason).toContain("Price must be positive");
    expect(result.clean).toBe(false);
  });

  it("applies a field-less userError to the whole group", async () => {
    const { client } = fakeClient({
      userErrors: [{ field: null, message: "Product is archived" }],
    });
    const result = await executeSync([row(), row({ ref: ref("gid://shopify/ProductVariant/2") })], {
      client,
      budget: budget(),
      productOf,
      random: () => 0,
      sleep: noSleep,
    });
    expect(result.failed).toBe(2);
    expect(result.clean).toBe(false);
  });

  it("extracts the index from a Shopify field path", () => {
    expect(indexFromField(["variants", "2", "price"])).toBe(2);
    expect(indexFromField(["variants"])).toBeUndefined();
    expect(indexFromField(null)).toBeUndefined();
  });
});

describe("read-back verification", () => {
  it("marks rows verified when the storefront matches", async () => {
    const { client } = fakeClient();
    const result = await executeSync([row()], {
      client,
      budget: budget(),
      productOf,
      verifySampleRate: 1,
      random: () => 0,
      sleep: noSleep,
    });
    expect(result.verified).toBe(1);
    expect(result.clean).toBe(true);
  });

  it("fails a row whose read-back disagrees", async () => {
    const { client } = fakeClient({
      readBack: { "gid://shopify/ProductVariant/1": "99.99" },
    });
    const result = await executeSync([row()], {
      client,
      budget: budget(),
      productOf,
      verifySampleRate: 1,
      random: () => 0,
      sleep: noSleep,
    });
    expect(result.rows[0].status).toBe("failed");
    expect(result.rows[0].failureReason).toContain("expected 80.00, found 99.99");
    expect(result.rows[0].observedPrice).toEqual(usd(9_999));
    expect(result.clean).toBe(false);
  });

  it("leaves unsampled rows unverified rather than claiming success", async () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      row({ ref: ref(`gid://shopify/ProductVariant/${i + 10}`) }),
    );
    const { client } = fakeClient();
    const result = await executeSync(rows, {
      client,
      budget: budget(),
      productOf,
      verifySampleRate: 0.1,
      random: () => 0,
      sleep: noSleep,
    });
    // Exactly one sampled; the rest are honestly reported as unverified.
    expect(result.verified).toBe(1);
    expect(result.unverified).toBe(9);
  });

  it("treats a failed verification read as unconfirmed, not as a failed write", async () => {
    let call = 0;
    const client: AdminClient = {
      async request<T>(query: string, variables: Record<string, unknown>) {
        call++;
        if (query.includes("productVariantsBulkUpdate")) {
          const variants = variables.variants as Array<{ id: string; price?: string }>;
          return {
            data: {
              productVariantsBulkUpdate: {
                productVariants: variants.map((v) => ({ id: v.id, price: v.price!, compareAtPrice: null })),
                userErrors: [],
              },
            } as T,
          };
        }
        throw new Error("network down");
      },
    };
    const result = await executeSync([row()], {
      client,
      budget: budget(),
      productOf,
      verifySampleRate: 1,
      random: () => 0,
      sleep: noSleep,
      maxAttempts: 1,
    });
    expect(result.rows[0].status).toBe("applied-unverified");
    expect(result.rows[0].failureReason).toContain("verification read failed");
    expect(result.clean).toBe(true); // no write failed
    expect(call).toBeGreaterThan(1);
  });
});

describe("throttle resilience (edge case E17)", () => {
  it("retries through a throttle storm and still completes clean", async () => {
    const { client } = fakeClient({ throwTimes: 3 });
    const result = await executeSync([row()], {
      client,
      budget: budget(),
      productOf,
      verifySampleRate: 1,
      random: () => 0,
      sleep: noSleep,
      maxAttempts: 5,
    });
    expect(result.clean).toBe(true);
    expect(result.verified).toBe(1);
  });

  it("gives up with a reason after exhausting attempts", async () => {
    const { client } = fakeClient({ throwTimes: 99 });
    const result = await executeSync([row()], {
      client,
      budget: budget(),
      productOf,
      random: () => 0,
      sleep: noSleep,
      maxAttempts: 2,
    });
    expect(result.failed).toBe(1);
    expect(result.clean).toBe(false);
  });

  it("does not retry a non-throttle error", async () => {
    const { client, calls } = fakeClient({
      throwTimes: 99,
      throwWith: new Error("Invalid product id"),
    });
    const result = await executeSync([row()], {
      client,
      budget: budget(),
      productOf,
      random: () => 0,
      sleep: noSleep,
      maxAttempts: 5,
    });
    expect(calls).toHaveLength(1);
    expect(result.rows[0].failureReason).toContain("Invalid product id");
  });
});

describe("budget manager", () => {
  it("mirrors the observed bucket rather than assuming a plan", () => {
    const b = new RateLimitBudget({ now: () => 0, sleep: noSleep });
    b.observe({
      throttleStatus: { maximumAvailable: 2_000, currentlyAvailable: 1_500, restoreRate: 100 },
    });
    expect(b.snapshot()).toMatchObject({ maximumAvailable: 2_000, restoreRate: 100 });
  });

  it("projects restore over elapsed time", () => {
    let t = 0;
    const b = new RateLimitBudget({ now: () => t, sleep: noSleep });
    b.observe({
      throttleStatus: { maximumAvailable: 1_000, currentlyAvailable: 0, restoreRate: 50 },
    });
    expect(b.available()).toBe(0);
    t = 2_000; // two seconds
    expect(b.available()).toBe(100);
  });

  it("never projects above the bucket maximum", () => {
    let t = 0;
    const b = new RateLimitBudget({ now: () => t, sleep: noSleep });
    b.observe({
      throttleStatus: { maximumAvailable: 1_000, currentlyAvailable: 900, restoreRate: 50 },
    });
    t = 1_000_000;
    expect(b.available()).toBe(1_000);
  });

  it("waits when the budget is short, and the wait scales with the deficit", () => {
    const b = new RateLimitBudget({ now: () => 0, sleep: noSleep });
    b.observe({
      throttleStatus: { maximumAvailable: 1_000, currentlyAvailable: 0, restoreRate: 50 },
    });
    expect(b.waitMsFor(100)).toBe(2_000);
    expect(b.waitMsFor(50)).toBe(1_000);
    expect(b.waitMsFor(0)).toBe(0);
  });

  it("caps a reservation at the usable maximum so it cannot wait forever", () => {
    const b = new RateLimitBudget({ now: () => 0, sleep: noSleep, headroom: 0.8 });
    b.observe({
      throttleStatus: { maximumAvailable: 1_000, currentlyAvailable: 0, restoreRate: 50 },
    });
    // Asking for more than the whole bucket must not produce an unbounded wait.
    expect(b.waitMsFor(10_000)).toBe(16_000); // 800 usable / 50 per second
  });

  it("debits optimistically so concurrent callers do not all see a full bucket", async () => {
    const b = new RateLimitBudget({ now: () => 0, sleep: noSleep });
    b.observe({
      throttleStatus: { maximumAvailable: 1_000, currentlyAvailable: 1_000, restoreRate: 50 },
    });
    await b.reserve(400);
    expect(b.available()).toBe(600);
    await b.reserve(400);
    expect(b.available()).toBe(200);
  });

  it("recognises throttling in each shape Shopify reports it", () => {
    expect(isThrottledError({ extensions: { code: "THROTTLED" } })).toBe(true);
    expect(isThrottledError({ networkStatusCode: 429 })).toBe(true);
    expect(isThrottledError({ message: "Throttled by Shopify" })).toBe(true);
    expect(isThrottledError(new Error("Invalid id"))).toBe(false);
    expect(isThrottledError(null)).toBe(false);
  });

  it("backs off with jitter so retries do not re-collide", async () => {
    const delays: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      delays.push(ms);
    });
    let attempts = 0;
    await withRetry(
      async () => {
        attempts++;
        if (attempts < 3) throw { extensions: { code: "THROTTLED" } };
        return "ok";
      },
      isThrottledError,
      { sleep, random: () => 0.5, baseDelayMs: 1_000 },
    );
    expect(attempts).toBe(3);
    // 1000 * 0.75, then 2000 * 0.75 -- growing, and jittered below the raw backoff.
    expect(delays).toEqual([750, 1_500]);
  });
});
