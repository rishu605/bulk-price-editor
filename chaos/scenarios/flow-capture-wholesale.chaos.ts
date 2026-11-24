/**
 * Flow's Capture baselines recaptures a wholesale price as the recapture page does (#1092).
 *
 * Since #1071 a wholesale price's baseline is the one every campaign reads, filed as MARKET,
 * and recorded with the price's quantity ladder or not at all -- the ladder is read from
 * Shopify, so a capture with no Admin client leaves wholesale prices as they were. The
 * recapture page passes its client; Flow's action did not, inline or from the worker. So a
 * wholesale price the merchant changed after the sync stayed "changed outside a campaign"
 * after Flow reported the segment captured, and the next sale computed from the old price.
 *
 * Every capture Flow asks for is the worker's since D29 (#808), however few ladder reads it
 * needs (#773 sent only large ones there), and the worker reads with the shop's client: the
 * scope's variants only (#704), 25 a read.
 *
 * Driven through the route's own action, as `flow-contract.chaos.ts` drives it: Flow's
 * authentication is replaced, the web queue records its jobs, and the worker's own handler
 * runs them.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { captureBaselines } from "../../app/services/baselines.server";
import { syncMarkets } from "../../app/services/markets-sync.server";
import { reconcile } from "../../app/services/reconciliation.server";
import type { JobRef, QueueName } from "../../app/worker/queues";
import { chaosAdminClient } from "../harness/http-client";
import { type ChaosContext, fixtureAdminClient, withChaos } from "../harness/scenario";

let pending: { shop: string; properties: Record<string, string>; admin?: unknown } = { shop: "", properties: {} };
let endpoint = "";
let session = true;
const enqueued: Array<{ name: QueueName; ref: JobRef }> = [];

vi.mock("../../app/shopify.server", () => ({
  authenticate: {
    flow: async () => ({ session: { shop: pending.shop }, payload: { properties: pending.properties }, admin: pending.admin }),
  },
}));

vi.mock("../../app/services/admin-client.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/services/admin-client.server")>();
  return {
    ...actual,
    adminClientForShop: async (domain: string) => (session ? fixtureAdminClient(domain, endpoint) : null),
    // The route hands Flow's `admin` to this; in the scenario that admin is the chaos client.
    toAdminClient: (admin: unknown) => (admin as { __chaos?: unknown })?.__chaos ?? actual.toAdminClient(admin as never),
  };
});

vi.mock("../../app/worker/web-queue.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../app/worker/web-queue.server")>()),
  webQueue: () => ({
    async enqueue(name: QueueName, ref: JobRef) {
      enqueued.push({ name, ref });
    },
    async depths() {
      return {};
    },
    async close() {},
  }),
}));

beforeEach(() => {
  enqueued.length = 0;
  session = true;
});

const CATALOG = { catalog: { products: 3, variantsPerProduct: 1 }, percent: -20 } as const;

const TRADE = {
  id: "gid://shopify/PriceList/trade-1092",
  catalog: { id: "gid://shopify/CompanyLocationCatalog/trade-1092", title: "Trade", __typename: "CompanyLocationCatalog" },
};

/** What the merchant's wholesale price is after they change it in Shopify: $55.00, 12+ at $48, 48+ at $44. */
const CHANGED = [
  { minimumQuantity: 12, amount: "48.00" },
  { minimumQuantity: 48, amount: "44.00" },
];

/**
 * A -10% wholesale catalogue whose first variant is set by hand at $50.00 with a 12+ ladder,
 * baselined by the sync. The merchant then changes it in Shopify -- $55.00, a new ladder --
 * and the markets sync mirrors the new price, so What's live calls it changed outside a
 * campaign while its baseline still says $50.00. Returns the segment Flow names.
 */
async function changedAfterTheSync(chaos: ChaosContext) {
  const { shopId, variantGids } = chaos.fixture;
  const [handSet] = variantGids;
  endpoint = chaos.server.endpoint();
  const client = chaosAdminClient(endpoint);

  chaos.fake.addPriceList({
    id: TRADE.id,
    name: "Trade",
    currency: "USD",
    adjustment: { type: "PERCENTAGE_DECREASE", value: 10 },
    catalog: TRADE.catalog,
    prices: [{ variantGid: handSet!, amount: "50.00", compareAt: null, originType: "FIXED" as const }],
  });
  chaos.fake.ladders.set(`${TRADE.id}|${handSet}`, [{ minimumQuantity: 12, amount: "45.00" }]);
  await syncMarkets(client, shopId);
  await captureBaselines(shopId, { client });
  expect(await wholesaleBaseline(chaos), "the sync did not baseline the wholesale price").toMatchObject({ basePrice: 5_000n });

  const list = chaos.fake.priceLists.find((entry) => entry.id === TRADE.id)!;
  list.prices[0]!.amount = "55.00";
  chaos.fake.ladders.set(`${TRADE.id}|${handSet}`, CHANGED.map((rung) => ({ ...rung })));
  await syncMarkets(client, shopId);
  expect((await reconcile(shopId, chaos.fixture.domain)).counts.offBaseline, "the changed wholesale price is not off its baseline").toBe(1);

  const { createSegment } = await import("../../app/services/segments-crud.server");
  return createSegment(shopId, { name: "flow-wholesale", kind: "FROZEN", variantGids });
}

/** The wholesale price's current baselines: there must be exactly one. */
async function wholesaleBaseline(chaos: ChaosContext) {
  const rows = await prisma.baseline.findMany({
    where: { shopId: chaos.fixture.shopId, priceListGid: TRADE.id, supersededAt: null },
    select: { surfaceKind: true, basePrice: true, quantityBreaks: true, handSet: true, source: true },
  });
  expect(rows, "the wholesale price does not have exactly one current baseline").toHaveLength(1);
  return rows[0];
}

/** Recaptured as the page recaptures it: where campaigns read it, at the new price, with the new ladder. */
const RECAPTURED = {
  surfaceKind: "MARKET",
  basePrice: 5_500n,
  quantityBreaks: [
    { minimumQuantity: 12, amount: 4_800 },
    { minimumQuantity: 48, amount: 4_400 },
  ],
  handSet: true,
  source: "RECAPTURE",
};

async function flowCapture(chaos: ChaosContext, segmentId: string) {
  pending = { shop: chaos.fixture.domain, properties: { "segment-id": segmentId }, admin: { __chaos: chaosAdminClient(endpoint) } };
  const { action } = await import("../../app/routes/flow.actions.capture-baselines");
  const response = (await action({
    request: new Request("https://example.invalid/flow/actions/capture-baselines", { method: "POST" }),
    params: {},
    context: {},
  } as never)) as Response;
  return { status: response.status, message: ((await response.json()) as { message: string }).message };
}

const flowActivity = async (shopId: string) =>
  (await prisma.auditLogEntry.findMany({ where: { shopId, action: "flow.capture-baselines" }, orderBy: { createdAt: "asc" } })).map(
    (entry) => entry.after as { outcome: string; status: number },
  );

describe("chaos: Flow's Capture baselines over a wholesale catalogue (#1092)", () => {
  it("hands even a one-read capture to the worker, which reads its ladder and counts it", async () => {
    await withChaos("flow-capture-wholesale-worker", CATALOG, async (chaos) => {
      const { shopId, domain } = chaos.fixture;
      const segment = await changedAfterTheSync(chaos);
      chaos.fake.ladderReads = 0;

      const answer = await flowCapture(chaos, segment.id);

      expect(answer.status).toBe(200);
      expect(answer.message).toMatch(/in the background/);
      expect(enqueued, "the capture was not handed to the worker").toEqual([{ name: "sync", ref: { shopId, recaptureSegmentId: segment.id } }]);
      expect(await wholesaleBaseline(chaos), "the queued capture ran inline").toMatchObject({ basePrice: 5_000n });

      const { handleJob } = await import("../../app/worker/handlers.server");
      await handleJob(enqueued[0]!.name, enqueued[0]!.ref);

      expect(await wholesaleBaseline(chaos), "the worker left the wholesale price's baseline as it was").toEqual(RECAPTURED);
      expect(chaos.fake.ladderReads, "one wholesale price took more than one ladder read").toBe(1);
      expect((await reconcile(shopId, domain)).counts.offBaseline, "What's live still calls the price changed outside a campaign").toBe(0);
      expect(await flowActivity(shopId)).toEqual([expect.objectContaining({ outcome: "queued", status: 200 })]);
      const [recaptured] = await prisma.auditLogEntry.findMany({ where: { shopId, action: "baselines.recapture" } });
      expect(recaptured!.after).toMatchObject({ wholesale: 1, wholesaleLeft: 0 });
    });
  });

  it("fails the worker's job rather than leave the wholesale prices as they were when it has no session", async () => {
    await withChaos("flow-capture-wholesale-no-session", CATALOG, async (chaos) => {
      const { shopId } = chaos.fixture;
      const segment = await changedAfterTheSync(chaos);
      await flowCapture(chaos, segment.id);
      session = false;

      const { handleJob } = await import("../../app/worker/handlers.server");
      await expect(handleJob(enqueued[0]!.name, enqueued[0]!.ref), "a capture that could not read the ladders reported success").rejects.toThrow(
        /No usable session.*Nothing was captured/,
      );

      expect(await prisma.baseline.count({ where: { shopId, source: "RECAPTURE" } }), "part of the scope was captured").toBe(0);
      expect(await wholesaleBaseline(chaos)).toMatchObject({ basePrice: 5_000n });
    });
  });
});
