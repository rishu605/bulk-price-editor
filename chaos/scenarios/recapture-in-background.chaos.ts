/**
 * The recapture page hands a recapture with too many ladder reads to the worker, and follows
 * it there (#1105).
 *
 * Since #1071 a wholesale price is recaptured with its quantity ladder or not at all, and the
 * ladder is read from Shopify, 25 prices a read, one read after another (#704). The page ran
 * every recapture inside its request, so a scope with 10,000 wholesale prices was 400 reads
 * -- minutes -- and a "502" past Railway's five while the recapture carried on. Flow's capture
 * already hands such a scope to the worker (#1092); the page had no such path.
 *
 * Now a recapture needing more reads than `PAGE_INLINE_LADDER_READS` -- counted by
 * `ladderReadsToCapture`, as Flow counts -- is checked in the request, then queued, and the
 * page follows its row: the step it is on and how far it has got, then what it did or why it
 * did not. The worker checks it again before writing, and refuses where the page can see.
 *
 * Driven through the page's own loader and action, the status route it polls and the
 * worker's own handler: `authenticate.admin` is replaced, the web queue records its jobs,
 * and the page's ladder budget is made small enough for two catalogues to be over it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import type { AdminClient } from "../../app/lib/execution/sync-executor";
import { captureBaselines } from "../../app/services/baselines.server";
import { syncMarkets } from "../../app/services/markets-sync.server";
import { reconcile } from "../../app/services/reconciliation.server";
import type { JobRef, QueueName } from "../../app/worker/queues";
import { chaosAdminClient } from "../harness/http-client";
import { type ChaosContext, fixtureAdminClient, withChaos } from "../harness/scenario";

let pending = { shop: "", endpoint: "" };
let session = true;
let queue = true;
let inlineLadderReads = 1;
const enqueued: Array<{ name: QueueName; ref: JobRef }> = [];
/** What the page's status poll said as each ladder read went out, while one is watched. */
const seen: string[] = [];
let watching: string | null = null;

vi.mock("../../app/shopify.server", () => ({
  authenticate: {
    admin: async () => ({
      session: { shop: pending.shop },
      sessionToken: { sub: "42" },
      // The route hands this to `toAdminClient`, replaced below with the chaos client.
      admin: { __chaos: true },
    }),
  },
}));

vi.mock("../../app/services/admin-client.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/services/admin-client.server")>();
  return {
    ...actual,
    adminClientForShop: async (domain: string) => {
      const client = session ? fixtureAdminClient(domain, pending.endpoint) : null;
      return client ? watched(client) : null;
    },
    toAdminClient: (admin: unknown) =>
      (admin as { __chaos?: unknown })?.__chaos ? watched(chaosAdminClient(pending.endpoint)) : actual.toAdminClient(admin as never),
  };
});

vi.mock("../../app/worker/web-queue.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../app/worker/web-queue.server")>()),
  webQueue: () =>
    queue
      ? {
          async enqueue(name: QueueName, ref: JobRef) {
            enqueued.push({ name, ref });
          },
          async depths() {
            return {};
          },
          async close() {},
        }
      : null,
}));

vi.mock("../../app/lib/execution/inline-budget", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/lib/execution/inline-budget")>();
  return {
    ...actual,
    get PAGE_INLINE_LADDER_READS() {
      return inlineLadderReads;
    },
  };
});

/**
 * The client, telling the scenario what the page would see as each ladder read leaves: the
 * status route's own answer, asked as the page polls it.
 */
function watched(client: AdminClient): AdminClient {
  return {
    async request(query, variables) {
      if (watching && query.includes("AnchorPriceListQuantityBreaks")) {
        const status = await pollStatus(watching);
        seen.push(status?.running ? (status.text ?? "") : `not running: ${status?.failure ?? status?.outcome}`);
      }
      return client.request(query, variables);
    },
  } as AdminClient;
}

beforeEach(() => {
  enqueued.length = 0;
  seen.length = 0;
  watching = null;
  session = true;
  queue = true;
  inlineLadderReads = 1;
});

const CATALOG = { catalog: { products: 4, variantsPerProduct: 1 }, percent: -20 } as const;

/** Two wholesale catalogues, two hand-set prices each, every one with a ladder. */
const LISTS = [
  {
    id: "gid://shopify/PriceList/trade-1105",
    name: "Trade",
    catalog: { id: "gid://shopify/CompanyLocationCatalog/trade-1105", title: "Trade", __typename: "CompanyLocationCatalog" },
    variants: [0, 1],
  },
  {
    id: "gid://shopify/PriceList/distributor-1105",
    name: "Distributor",
    catalog: { id: "gid://shopify/CompanyLocationCatalog/distributor-1105", title: "Distributor", __typename: "CompanyLocationCatalog" },
    variants: [2, 3],
  },
];

/** The merchant's prices after they change them in Shopify: $55.00 (or $65.00), 12+ and 48+ cheaper. */
const changedPrice = (index: number) => (index % 2 === 0 ? "55.00" : "65.00");
const changedLadder = (index: number) => [
  { minimumQuantity: 12, amount: index % 2 === 0 ? "48.00" : "58.00" },
  { minimumQuantity: 48, amount: index % 2 === 0 ? "44.00" : "54.00" },
];

/**
 * Two wholesale catalogues baselined by the sync at $50.00 with a 12+ ladder, then changed by
 * the merchant in Shopify -- new prices, new ladders -- and mirrored by the markets sync, so
 * What's live calls all four changed outside a campaign. Recapturing is the merchant's fix.
 */
async function wholesaleChangedAfterTheSync(chaos: ChaosContext) {
  const { shopId, variantGids, domain } = chaos.fixture;
  pending = { shop: domain, endpoint: chaos.server.endpoint() };
  const client = chaosAdminClient(pending.endpoint);

  for (const list of LISTS) {
    chaos.fake.addPriceList({
      id: list.id,
      name: list.name,
      currency: "USD",
      adjustment: { type: "PERCENTAGE_DECREASE", value: 10 },
      catalog: list.catalog,
      prices: list.variants.map((index) => ({ variantGid: variantGids[index]!, amount: "50.00", compareAt: null, originType: "FIXED" as const })),
    });
    for (const index of list.variants) chaos.fake.ladders.set(`${list.id}|${variantGids[index]}`, [{ minimumQuantity: 12, amount: "45.00" }]);
  }
  await syncMarkets(client, shopId);
  await captureBaselines(shopId, { client });
  expect(await wholesaleBaselines(chaos), "the sync did not baseline the wholesale prices").toHaveLength(4);

  for (const list of LISTS) {
    const fake = chaos.fake.priceLists.find((entry) => entry.id === list.id)!;
    for (const index of list.variants) {
      fake.prices.find((price) => price.variantGid === variantGids[index])!.amount = changedPrice(index);
      chaos.fake.ladders.set(`${list.id}|${variantGids[index]}`, changedLadder(index));
    }
  }
  await syncMarkets(client, shopId);
  expect((await reconcile(shopId, domain)).counts.offBaseline, "the changed wholesale prices are not off their baselines").toBe(4);
  chaos.fake.ladderReads = 0;
}

/** Every wholesale price's current baselines, one row per price. */
async function wholesaleBaselines(chaos: ChaosContext) {
  return prisma.baseline.findMany({
    where: { shopId: chaos.fixture.shopId, priceListGid: { in: LISTS.map((list) => list.id) }, supersededAt: null },
    select: { variantGid: true, priceListGid: true, surfaceKind: true, basePrice: true, quantityBreaks: true, ladderRead: true, source: true },
    orderBy: { variantGid: "asc" },
  });
}

/** What every wholesale baseline should be once recaptured: where campaigns read it, today's price, today's ladder. */
function recaptured(chaos: ChaosContext) {
  return LISTS.flatMap((list) =>
    list.variants.map((index) => ({
      variantGid: chaos.fixture.variantGids[index]!,
      priceListGid: list.id,
      surfaceKind: "MARKET",
      basePrice: BigInt(Math.round(Number(changedPrice(index)) * 100)),
      quantityBreaks: changedLadder(index).map((rung) => ({ minimumQuantity: rung.minimumQuantity, amount: Math.round(Number(rung.amount) * 100) })),
      ladderRead: true,
      source: "RECAPTURE",
    })),
  ).sort((a, b) => a.variantGid.localeCompare(b.variantGid));
}

const PAGE = "https://example.invalid/app/prices/baselines/recapture";

type Followed = { id: string; running: boolean; text: string | null; outcome: string | null; failure: string | null; partial: boolean };

async function load(query = "") {
  const { loader } = await import("../../app/routes/app.prices.baselines.recapture");
  return (await loader({ request: new Request(`${PAGE}${query}`), params: {}, context: {} } as never)) as {
    assessment: { scope: number; confirmationPhrase: string | null };
    background?: Followed | null;
  };
}

async function press(fields: Record<string, string>) {
  const { action } = await import("../../app/routes/app.prices.baselines.recapture");
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return (await action({ request: new Request(PAGE, { method: "POST", body }), params: {}, context: {} } as never)) as {
    ok: boolean;
    message: string;
    recapture?: string;
  };
}

/** What the page's poll hears: the status route, asked as the page asks it. */
async function pollStatus(id: string): Promise<Followed | null> {
  const { loader } = await import("../../app/routes/app.recapture-status");
  return ((await loader({ request: new Request(`https://example.invalid/app/recapture-status?id=${id}`), params: {}, context: {} } as never)) as {
    recapture: Followed | null;
  }).recapture;
}

async function runTheJob() {
  const { handleJob } = await import("../../app/worker/handlers.server");
  const job = enqueued.shift()!;
  await handleJob(job.name, job.ref);
}

const recapturedCount = (shopId: string) => prisma.baseline.count({ where: { shopId, source: "RECAPTURE" } });

describe("chaos: a recapture from the page with more ladder reads than the page can wait on (#1105)", () => {
  it("is checked, handed to the worker, followed step by step, and recaptures every wholesale price with its ladder", async () => {
    await withChaos("recapture-in-background", CATALOG, async (chaos) => {
      const { shopId, domain } = chaos.fixture;
      await wholesaleChangedAfterTheSync(chaos);

      const page = await load();
      expect(page.assessment.scope).toBe(4);
      // Two catalogues, two reads: one more than this budget.
      const answer = await press({ segment: "", scope: String(page.assessment.scope) });

      expect(enqueued, "the recapture over the page's ladder budget was not handed to the worker").toEqual([
        { name: "sync", ref: { shopId, recaptureId: answer.recapture } },
      ]);
      expect(answer.ok, answer.message).toBe(true);
      expect(answer.message).toMatch(/^Recapturing 4 variants in the background: reading their wholesale prices' quantity breaks/);
      expect(chaos.fake.ladderReads, "the request read the ladders it handed over").toBe(0);
      expect(await recapturedCount(shopId), "the request recaptured what it handed over").toBe(0);

      // The page follows it: waiting for the worker, and no second recapture meanwhile.
      const id = answer.recapture!;
      expect(await pollStatus(id)).toMatchObject({ id, running: true, text: "Waiting for the background worker" });
      expect((await load(`?recapture=${id}`)).background).toMatchObject({ id, running: true });
      expect((await load()).background, "a tab that did not start it does not see it running").toMatchObject({ id, running: true });
      const again = await press({ segment: "", scope: "4" });
      expect(again.ok).toBe(false);
      expect(again.message).toMatch(/Another recapture is already running for this store, so nothing more was started/);
      expect(enqueued, "a second recapture was queued beside the first").toHaveLength(1);

      const { recaptureTiming } = await import("../../app/services/recapture-job.server");
      recaptureTiming.progressMs = 0;
      watching = id;
      await runTheJob();
      watching = null;

      // Each ladder read, as the page would have seen it go out: the step, then how far it had got.
      expect(seen).toEqual([
        "Reading wholesale quantity breaks from Shopify",
        "Reading wholesale quantity breaks from Shopify: 2 of 4 prices",
      ]);
      expect(chaos.fake.ladderReads, "a catalogue took more than one read").toBe(2);

      const done = await pollStatus(id);
      expect(done).toMatchObject({ id, running: false, failure: null, partial: false });
      // The store prices did not change, so their baselines are left alone and counted (#781).
      expect(done!.outcome).toBe(
        "Recaptured 4 baselines across 4 variants, superseding 4, including 4 wholesale prices with their quantity breaks. " +
          "4 were already correct.",
      );
      expect((await load(`?recapture=${id}`)).background, "the page that reloads does not say how it ended").toMatchObject({
        outcome: done!.outcome,
      });

      expect(await wholesaleBaselines(chaos), "a wholesale price was not recaptured with its ladder").toEqual(recaptured(chaos));
      expect((await reconcile(shopId, domain)).counts.offBaseline, "What's live still calls a price changed outside a campaign").toBe(0);
      const [audit] = await prisma.auditLogEntry.findMany({ where: { shopId, action: "baselines.recapture" } });
      expect(audit).toMatchObject({ actor: "staff:42", after: expect.objectContaining({ scope: 4, wholesale: 4, wholesaleLeft: 0 }) });

      // A resent job finds it finished and adds nothing.
      enqueued.push({ name: "sync", ref: { shopId, recaptureId: id } });
      await runTheJob();
      expect(await recapturedCount(shopId), "a resent job recaptured again").toBe(4);
    });
  });

  it("checks the typed confirmation before queueing, and refuses in the worker a campaign gone live since", async () => {
    await withChaos("recapture-in-background-confirm", CATALOG, async (chaos) => {
      const { shopId, campaignId } = chaos.fixture;
      await wholesaleChangedAfterTheSync(chaos);

      // A sale running over the scope: the phrase is demanded before anything is queued.
      await prisma.campaign.update({ where: { id: campaignId }, data: { status: "ACTIVE" } });
      expect((await load()).assessment.confirmationPhrase).toBe("REPLACE BASELINES");
      const untyped = await press({ segment: "", scope: "4", confirmation: "" });
      expect(untyped.ok).toBe(false);
      expect(untyped.message).toMatch(/on sale right now.*Type “REPLACE BASELINES” to confirm/);
      expect(enqueued, "an unconfirmed recapture was queued").toEqual([]);
      expect(await prisma.baselineRecapture.count({ where: { shopId } }), "an unconfirmed recapture was claimed").toBe(0);

      // No sale when it is confirmed; one goes live before the worker gets to it.
      await prisma.campaign.update({ where: { id: campaignId }, data: { status: "DRAFT" } });
      const answer = await press({ segment: "", scope: "4" });
      expect(enqueued).toHaveLength(1);
      await prisma.campaign.update({ where: { id: campaignId }, data: { status: "ACTIVE" } });
      await runTheJob();

      const refused = await pollStatus(answer.recapture!);
      expect(refused).toMatchObject({ running: false, outcome: null });
      expect(refused!.failure).toMatch(
        /^Nothing was recaptured: "chaos\/recapture-in-background-confirm" \(4 variants\) went live on this scope after you confirmed the recapture/,
      );
      expect(await recapturedCount(shopId), "the worker recaptured over a sale nobody confirmed").toBe(0);
      expect(chaos.fake.ladderReads, "the worker read Shopify for a recapture it refused").toBe(0);

      // Typed over the sale, it is the merchant's call, and it runs.
      const typed = await press({ segment: "", scope: "4", confirmation: "replace baselines" });
      expect(typed.ok, typed.message).toBe(true);
      await runTheJob();
      expect((await pollStatus(typed.recapture!))!.outcome).toMatch(/^Recaptured 4 baselines/);
      expect(await wholesaleBaselines(chaos)).toEqual(recaptured(chaos));
    });
  });

  it("refuses in the worker a scope that changed since the page showed it", async () => {
    await withChaos("recapture-in-background-scope", CATALOG, async (chaos) => {
      const { shopId, variantGids } = chaos.fixture;
      await wholesaleChangedAfterTheSync(chaos);
      const { createSegment } = await import("../../app/services/segments-crud.server");
      const segment = await createSegment(shopId, { name: `recapture-1105-${chaos.seed}`, kind: "FROZEN", variantGids });

      const page = await load(`?segment=${segment.id}`);
      const answer = await press({ segment: segment.id, scope: String(page.assessment.scope) });
      expect(enqueued).toHaveLength(1);
      await prisma.segment.update({ where: { id: segment.id }, data: { frozenVariantGids: variantGids.slice(0, 3) } });
      await runTheJob();

      expect((await pollStatus(answer.recapture!))!.failure).toBe(
        "This scope is 3 variants now, not the 4 you were shown, so nothing was recaptured. Check the scope again and read the new count before recapturing.",
      );
      expect(await recapturedCount(shopId)).toBe(0);
    });
  });

  it("notices a recapture the worker never picked up, frees the shop for the next, and does not run the old one late", async () => {
    await withChaos("recapture-in-background-stalled", CATALOG, async (chaos) => {
      const { shopId } = chaos.fixture;
      await wholesaleChangedAfterTheSync(chaos);

      const first = await press({ segment: "", scope: "4" });
      // Eleven minutes with nobody stamping it: the worker that should have taken it is gone.
      await prisma.baselineRecapture.update({ where: { id: first.recapture! }, data: { heartbeatAt: new Date(Date.now() - 11 * 60_000) } });
      const stalled = await pollStatus(first.recapture!);
      expect(stalled!.running, "a recapture nobody is running still read as running").toBe(false);
      expect(stalled!.failure).toMatch(/never started: the background worker did not pick it up within ten minutes, so nothing was recaptured/);

      const second = await press({ segment: "", scope: "4" });
      expect(second.ok, "a stalled recapture held the shop").toBe(true);
      expect(enqueued).toHaveLength(2);

      // The first job turns up late and does nothing; the second recaptures.
      await runTheJob();
      expect(await recapturedCount(shopId), "a recapture the page had called stopped ran anyway").toBe(0);
      await runTheJob();
      expect(await wholesaleBaselines(chaos)).toEqual(recaptured(chaos));
    });
  });

  it("says which wholesale prices it left when a catalogue's quantity breaks cannot be read", async () => {
    await withChaos("recapture-in-background-partial", CATALOG, async (chaos) => {
      const { shopId } = chaos.fixture;
      await wholesaleChangedAfterTheSync(chaos);
      const answer = await press({ segment: "", scope: "4" });
      // Shopify fails every read of the second catalogue's ladders.
      chaos.arm([
        { fault: "server-error", match: (query, variables) => query.includes("AnchorPriceListQuantityBreaks") && variables.id === LISTS[1]!.id },
      ]);

      await runTheJob();
      chaos.heal();

      const done = await pollStatus(answer.recapture!);
      expect(done, "a recapture that left wholesale prices was shown as clean").toMatchObject({ running: false, partial: true, failure: null });
      expect(done!.outcome).toBe(
        "Recaptured 2 baselines across 4 variants, superseding 2, including 2 wholesale prices with their quantity breaks. " +
          "4 were already correct. 2 wholesale prices were left as they were: their quantity breaks could not be read from " +
          "Shopify. Recapture again to include them.",
      );
      const left = await prisma.baseline.findMany({ where: { shopId, priceListGid: LISTS[1]!.id, supersededAt: null } });
      expect(left.map((baseline) => baseline.source), "a price whose ladder was not read was recaptured anyway").toEqual(["INSTALL_CAPTURE", "INSTALL_CAPTURE"]);
    });
  });

  it("says why when the worker has no session, rather than leaving the page waiting", async () => {
    await withChaos("recapture-in-background-no-session", CATALOG, async (chaos) => {
      const { shopId } = chaos.fixture;
      await wholesaleChangedAfterTheSync(chaos);
      const answer = await press({ segment: "", scope: "4" });
      session = false;

      await runTheJob();
      expect((await pollStatus(answer.recapture!))!.failure).toBe(
        "The app has no working session for this store, so the quantity breaks of its wholesale prices could not be read and " +
          "nothing was recaptured. Open the app again from Shopify admin, then recapture.",
      );
      expect(await recapturedCount(shopId)).toBe(0);
    });
  });

  it("runs while the page waits, as it always did, under the budget or with no worker queue", async () => {
    await withChaos("recapture-in-background-inline", CATALOG, async (chaos) => {
      const { shopId } = chaos.fixture;
      await wholesaleChangedAfterTheSync(chaos);

      inlineLadderReads = 2;
      const within = await press({ segment: "", scope: "4" });
      expect(enqueued, "a recapture within the budget was handed to the worker").toEqual([]);
      expect(within).toMatchObject({ ok: true, message: expect.stringMatching(/^Recaptured 4 baselines .* including 4 wholesale prices/) });
      expect(within.recapture).toBeUndefined();
      expect(await wholesaleBaselines(chaos)).toEqual(recaptured(chaos));

      // Over the budget with nowhere to send it: here, as before (#1105 changes nothing without a queue).
      inlineLadderReads = 1;
      queue = false;
      const reads = chaos.fake.ladderReads;
      const noWorker = await press({ segment: "", scope: "4" });
      expect(noWorker.ok, noWorker.message).toBe(true);
      expect(chaos.fake.ladderReads, "the recapture did not run here").toBeGreaterThan(reads);
      // Everything it read is what the first one recorded, so nothing is superseded again (#781).
      expect(noWorker.message).toBe("Recaptured 0 baselines across 4 variants. 8 were already correct.");
      expect(await recapturedCount(shopId)).toBe(4);
      expect(await prisma.baselineRecapture.count({ where: { shopId, finishedAt: null } }), "an inline recapture held the shop after it ended").toBe(0);
    });
  });
});
