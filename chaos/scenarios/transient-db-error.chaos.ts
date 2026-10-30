/**
 * A run waits out a busy database rather than ending on it (#810).
 *
 * On anchor-perf a 102k-variant run held the pool for forty minutes and failed its own writes
 * with P2024 (#802, #805). Each one ended the run: Partial over prices that had landed, a
 * Resume button, an email saying it stopped part-way -- for a database that would have
 * answered a second later. P2024 (no connection from the pool) and P2034 (rolled back by a
 * conflict or deadlock) both mean the statement never committed, so the run retries that
 * statement after a pause, and carries on.
 *
 * What these assert is the whole of "carries on": the run ends Completed and every price is
 * verified against the store, the campaign goes Applying → Active and nowhere else -- the
 * claim is never handed back, as it was before writing, and never Partial, as it was after --
 * and one run row did it. Plus the other half of #810: a run over more than a thousand
 * variants never sends one statement carrying more than a thousand of them.
 *
 * Each fault fires once, through a spy on the real client, so the retry meets the same
 * Postgres the first attempt did.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { withChaos, type ChaosContext } from "../harness/scenario";

afterEach(() => {
  vi.restoreAllMocks();
});

const busy = (code: "P2024" | "P2034") =>
  Object.assign(
    new Error(
      code === "P2024"
        ? "Timed out fetching a new connection from the connection pool (Current connection pool timeout: 10, connection limit: 10)"
        : "Transaction failed due to a write conflict or a deadlock. Please retry your transaction",
    ),
    { code },
  );

/** Every state this campaign was moved to, oldest first. */
async function movesOf(shopId: string, campaignId: string): Promise<string[]> {
  const entries = await prisma.auditLogEntry.findMany({
    where: { shopId, entityId: campaignId, action: "campaign.transition" },
    orderBy: { createdAt: "asc" },
    select: { after: true },
  });
  return entries.map((entry) => (entry.after as { status?: string } | null)?.status ?? "?");
}

/** The run finished, verified, as the only run, and its campaign never left the claim but for Active. */
async function expectFinishedClean(chaos: ChaosContext, outcome: { runId: string; clean: boolean; messages: string[] }) {
  const { shopId, campaignId, variantGids } = chaos.fixture;

  expect(outcome.clean, `the run ended unclean: ${outcome.messages.join(" | ")}`).toBe(true);
  await chaos.expectHonest(outcome.runId);

  const runs = await prisma.campaignRun.findMany({ where: { campaignId } });
  expect(runs, "one run did it, not a failed one and a second").toHaveLength(1);
  expect(runs[0]!.status).toBe("COMPLETED");
  expect(runs[0]!.verifiedRows).toBe(variantGids.length);

  expect(
    await movesOf(shopId, campaignId),
    "the claim was handed back or the run went Partial over a transient error",
  ).toEqual(["APPLYING", "ACTIVE"]);
}

describe("chaos: the database is busy for a moment during a run", () => {
  it("waits out a pool timeout recording what landed, and finishes clean", async () => {
    // #802's own failure: the prices are written and read back, then the statement recording
    // them cannot get a connection. That ended the run Partial over every verified price.
    await withChaos("transient-db-results", { catalog: { products: 6, variantsPerProduct: 1 }, percent: -10 }, async (chaos) => {
      const updateMany = prisma.variantChange.updateMany.bind(prisma.variantChange);
      let verifiedAttempts = 0;
      vi.spyOn(prisma.variantChange, "updateMany").mockImplementation(((args: { data?: { status?: string } }) => {
        if (args.data?.status === "VERIFIED" && verifiedAttempts++ === 0) throw busy("P2024");
        return updateMany(args as never);
      }) as never);

      const applied = await chaos.apply();
      vi.restoreAllMocks();

      expect(verifiedAttempts, "the statement was never retried").toBeGreaterThanOrEqual(2);
      await expectFinishedClean(chaos, applied);
      for (const gid of chaos.fixture.variantGids) {
        expect(chaos.fake.priceOf(gid)).toBe(((chaos.fixture.baseline.get(gid)! * 0.9) / 100).toFixed(2));
      }
    });
  });

  it("retries a deadlock writing the ledger, before any price is sent, without handing the claim back", async () => {
    // Before a price is written a failure hands the campaign back to Draft and the merchant
    // presses Apply again. For a transient error that is a round trip for nothing -- and a
    // scheduled start loses its slot until the next tick.
    await withChaos("transient-db-ledger", { catalog: { products: 4, variantsPerProduct: 1 }, percent: -15 }, async (chaos) => {
      const createMany = prisma.variantChange.createMany.bind(prisma.variantChange);
      let attempts = 0;
      vi.spyOn(prisma.variantChange, "createMany").mockImplementation(((args: unknown) => {
        if (attempts++ === 0) throw busy("P2034");
        return createMany(args as never);
      }) as never);

      const applied = await chaos.apply();
      vi.restoreAllMocks();

      await expectFinishedClean(chaos, applied);
      // Ledger before write (I4), retry or not: one row per variant, none twice.
      const rows = await prisma.variantChange.findMany({ where: { runId: applied.runId } });
      expect(rows).toHaveLength(chaos.fixture.variantGids.length);
    });
  });

  it("waits out a pool timeout on a market's results, so the market is not left unfinished", async () => {
    // A market's failure is caught and reported as "market prices did not finish", which is
    // right for Shopify refusing a price and wrong for the app's own database being busy.
    await withChaos("transient-db-market", { catalog: { products: 3, variantsPerProduct: 1 }, percent: -20 }, async (chaos) => {
      const { shopId, campaignId } = chaos.fixture;
      await withEuropeanMarket(chaos);

      const updateMany = prisma.variantChange.updateMany.bind(prisma.variantChange);
      let marketAttempts = 0;
      vi.spyOn(prisma.variantChange, "updateMany").mockImplementation(((args: { where?: { priceListGid?: unknown }; data?: { status?: string } }) => {
        const onMarket = typeof args.where?.priceListGid === "string" && args.where.priceListGid !== "";
        if (onMarket && args.data?.status === "VERIFIED" && marketAttempts++ === 0) throw busy("P2024");
        return updateMany(args as never);
      }) as never);

      const applied = await chaos.apply();
      vi.restoreAllMocks();

      expect(marketAttempts, "the market's statement was never retried").toBeGreaterThanOrEqual(2);
      expect(applied.messages.join(" ")).not.toMatch(/market prices did not finish/);
      await expectFinishedClean(chaos, applied);
      const market = await prisma.variantChange.findMany({ where: { runId: applied.runId, shopId, surfaceKind: "MARKET" } });
      expect(market).toHaveLength(chaos.fixture.variantGids.length);
      expect(market.every((row) => row.status === "VERIFIED")).toBe(true);
      expect(chaos.fake.fixedPricesOn(EUROPE).size).toBe(chaos.fixture.variantGids.length);
      expect(campaignId).toBeTruthy();
    });
  });

  it("writes a 1,100-variant run a thousand rows a statement at most", async () => {
    // The bound itself, measured at the client rather than read off the source: every write
    // the run sends to its ledger, its write intents and its market mirror, with the size of
    // the largest `IN` list or insert in it. `recordResults` sent 1,100 ids in one statement,
    // the market's results the same, and the write intents one insert of every row.
    await withChaos("transient-db-bounded", { catalog: { products: 1_100, variantsPerProduct: 1 }, percent: -10 }, async (chaos) => {
      await withEuropeanMarket(chaos);
      const largest = watchStatementSizes();

      const applied = await chaos.apply({ forcePath: "bulk" });
      vi.restoreAllMocks();

      await expectFinishedClean(chaos, applied);
      const over = [...largest].filter(([, size]) => size > 1_000).map(([statement, size]) => `${statement}: ${size}`);
      expect(over, "a statement carried more than a thousand rows").toEqual([]);
      expect(largest.size, "watched nothing, so the bound above was never tested").toBeGreaterThan(3);
    });
  });
});

const EUROPE = "gid://shopify/PriceList/eu";

/** A -10% EUR market the campaign also prices, with a strike-through so each price is written. */
async function withEuropeanMarket(chaos: ChaosContext): Promise<void> {
  const { shopId, campaignId } = chaos.fixture;
  chaos.fake.addPriceList({
    id: EUROPE,
    name: "Europe",
    currency: "EUR",
    country: "DE",
    adjustment: { type: "PERCENTAGE_DECREASE", value: 10 },
    catalog: { id: "gid://shopify/MarketCatalog/eu", title: "EU", __typename: "MarketCatalog" },
    prices: [],
  });
  const { syncMarkets } = await import("../../app/services/markets-sync.server");
  const { chaosAdminClient } = await import("../harness/http-client");
  await syncMarkets(chaosAdminClient(chaos.server.endpoint()), shopId);
  await prisma.campaign.update({
    where: { id: campaignId },
    data: {
      surfaces: { base: true, priceLists: [EUROPE] } as never,
      compareAtPolicy: { kind: "set-to-baseline" } as never,
    },
  });
}

/** The largest list each write statement carried, by model and operation, from here on. */
function watchStatementSizes(): Map<string, number> {
  const largest = new Map<string, number>();
  const note = (statement: string, size: number) => largest.set(statement, Math.max(largest.get(statement) ?? 0, size));
  const inLists = (value: unknown): number[] => {
    if (!value || typeof value !== "object") return [];
    return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) =>
      key === "in" && Array.isArray(entry) ? [entry.length] : inLists(entry),
    );
  };

  const delegates = {
    variantChange: prisma.variantChange,
    writeIntent: prisma.writeIntent,
    priceSurfaceEntry: prisma.priceSurfaceEntry,
  } as const;
  for (const [model, delegate] of Object.entries(delegates)) {
    for (const operation of ["createMany", "updateMany", "deleteMany"] as const) {
      const target = delegate as unknown as Record<string, (args: unknown) => unknown>;
      if (typeof target[operation] !== "function") continue;
      const original = target[operation]!.bind(delegate);
      vi.spyOn(target, operation).mockImplementation(((args: { data?: unknown; where?: unknown }) => {
        const sizes = [...inLists(args?.where), ...(Array.isArray(args?.data) ? [args.data.length] : [])];
        if (sizes.length > 0) note(`${model}.${operation}`, Math.max(...sizes));
        return original(args);
      }) as never);
    }
  }
  return largest;
}
