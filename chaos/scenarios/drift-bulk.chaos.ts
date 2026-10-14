/**
 * Deciding many drifted prices at once (#822).
 *
 * The queue resolved one price at a time, fifteen on screen: 1,113 drifted prices were
 * 1,113 clicks, with no filter, no export and no way to put them back other than one run
 * per row, while the campaign stayed Held. These drive the drift page's own loader and
 * action, and the export route, with only `authenticate.admin` replaced by an admin that
 * talks to the fake store. Work the page hands to the worker goes to a recorder and is
 * then run through the worker's own `handleJob`, as `apply-over-budget` does.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { holdForDrift } from "../../app/services/campaigns/lifecycle.server";
import type { JobRef, QueueName } from "../../app/worker/queues";
import { isVariantWrite } from "../harness/faults";
import { chaosAdminClient } from "../harness/http-client";
import { withChaos, type ChaosContext } from "../harness/scenario";

let pending = { shop: "", endpoint: "" };
const enqueued: Array<{ name: QueueName; ref: JobRef }> = [];
const limits = vi.hoisted(() => ({ budgetMs: 2 * 60 * 1000, inlineRows: 1_000 }));

vi.mock("../../app/shopify.server", () => ({
  authenticate: {
    admin: async () => ({
      session: { shop: pending.shop },
      sessionToken: { sub: "42" },
      admin: {
        async graphql(query: string, options?: { variables?: Record<string, unknown> }) {
          const response = await fetch(pending.endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query, variables: options?.variables ?? {} }),
          });
          return { json: () => response.json() };
        },
      },
    }),
  },
}));

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

vi.mock("../../app/services/admin-client.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/services/admin-client.server")>();
  return { ...actual, adminClientForShop: async () => chaosAdminClient(pending.endpoint) };
});

// Read on every use, so one scenario can sit a fixture of a few prices on the far side
// of a limit sized for thousands.
vi.mock("../../app/lib/execution/inline-budget", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/lib/execution/inline-budget")>();
  return {
    ...actual,
    get PAGE_INLINE_BUDGET_MS() {
      return limits.budgetMs;
    },
  };
});
vi.mock("../../app/lib/drift/batch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/lib/drift/batch")>();
  return {
    ...actual,
    get DRIFT_INLINE_ROWS() {
      return limits.inlineRows;
    },
  };
});

beforeEach(() => {
  enqueued.length = 0;
  limits.budgetMs = 2 * 60 * 1000;
  limits.inlineRows = 1_000;
});

const STAFF = "staff:42";

interface Page {
  rows: Array<{ id: string; variantGid: string; direction: string | null }>;
  total: number;
  filtered: number;
  campaigns: Array<{ id: string; name: string; pending: number }>;
  bulk: { id: string; name: string } | null;
  matchingCampaigns: number;
  asOf: string;
  status: { done: { resolved: number } | null; progress: { done: number; started: boolean; written: number | null } } | null;
}

async function load(query = ""): Promise<Page> {
  const { loader } = await import("../../app/routes/app.prices.drift");
  return (await loader({
    request: new Request(`https://example.invalid/app/prices/drift?${query}`),
    params: {},
    context: {},
  } as never)) as unknown as Page;
}

type Answer = { ok: boolean; message: string; batch?: string };

async function decide(fields: Record<string, string>): Promise<Answer> {
  const { action } = await import("../../app/routes/app.prices.drift");
  const body = new FormData();
  body.set("intent", "bulk");
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  const response = await action({
    request: new Request("https://example.invalid/app/prices/drift", { method: "POST", body }),
    params: {},
    context: {},
  } as never);
  return (response instanceof Response ? await response.json() : response) as Answer;
}

async function runTheJobs() {
  const { handleJob } = await import("../../app/worker/handlers.server");
  for (const job of enqueued.splice(0)) await handleJob(job.name, job.ref);
}

/** Minor units of a price the fake store shows. */
const cents = (price: string | undefined) => Math.round(Number(price) * 100);

/** An applied campaign, every row read back. Returns each variant's campaign price, in cents. */
async function applied(chaos: ChaosContext) {
  pending = { shop: chaos.fixture.domain, endpoint: chaos.server.endpoint() };
  await chaos.expectHonest((await chaos.apply()).runId);
  return new Map(chaos.fixture.variantGids.map((gid) => [gid, cents(chaos.fake.priceOf(gid))]));
}

/**
 * A merchant's edit to one variant, as the webhook records it: the store and the mirror
 * show the new price, and the queue holds an event for the campaign that set it.
 */
async function edit(chaos: ChaosContext, campaignId: string, variantGid: string, expected: number, observed: number) {
  const { shopId } = chaos.fixture;
  chaos.fake.variants.get(variantGid)!.price = (observed / 100).toFixed(2);
  await prisma.priceSurfaceEntry.updateMany({
    where: { shopId, variantGid, surfaceKind: "BASE" },
    data: { livePrice: BigInt(observed) },
  });
  const event = await prisma.driftEvent.create({
    data: {
      shopId,
      variantGid,
      surfaceKind: "BASE",
      campaignId,
      observedPrice: BigInt(observed),
      expectedPrice: BigInt(expected),
      currency: "USD",
    },
  });
  await holdForDrift(shopId, campaignId, variantGid);
  return event;
}

/** A second running campaign, holding drift of its own. */
async function bystander(shopId: string) {
  return prisma.campaign.create({
    data: {
      shopId,
      name: "Bystander sale",
      status: "ACTIVE",
      priority: 1,
      ruleRows: [] as never,
      surfaces: { base: true, priceLists: [] } as never,
      compareAtPolicy: { kind: "leave" } as never,
      compareAtViolationPolicy: "clear",
      guardrails: {} as never,
      guardrailViolationPolicy: "clamp",
      schedule: { kind: "manual" } as never,
    },
    select: { id: true },
  });
}

const statusOf = async (id: string) =>
  (await prisma.campaign.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;

const resolutionsOf = async (shopId: string) =>
  new Map(
    (await prisma.driftEvent.findMany({ where: { shopId }, select: { variantGid: true, resolution: true } })).map(
      (event) => [event.variantGid, event.resolution],
    ),
  );

const bulkEntries = (shopId: string, action: string) =>
  prisma.auditLogEntry.findMany({ where: { shopId, action, entity: "Campaign" }, orderBy: { createdAt: "asc" } });

describe("chaos: deciding many drifted prices at once", () => {
  it("filters by campaign, product and direction, and counts the filtered set against the true total", async () => {
    await withChaos("drift-bulk-filters", { catalog: { products: 18, variantsPerProduct: 1 }, percent: -30 }, async (chaos) => {
      const { shopId, campaignId, variantGids } = chaos.fixture;
      const sale = await applied(chaos);
      const other = await bystander(shopId);

      // Seventeen edits on the sale: odd ones raised, even ones lowered. One on the bystander.
      const ours = variantGids.slice(0, 17);
      for (const [index, gid] of ours.entries()) {
        await edit(chaos, campaignId, gid, sale.get(gid)!, sale.get(gid)! + (index % 2 === 0 ? -100 : 100));
      }
      const theirs = variantGids[17];
      await edit(chaos, other.id, theirs, sale.get(theirs)!, sale.get(theirs)! - 50);
      // A product a merchant would search for.
      await prisma.variantIndex.update({
        where: { shopId_variantGid: { shopId, variantGid: ours[3] } },
        data: { title: "Blue 100% Wool Scarf · Default", sku: "SCARF-BLUE" },
      });

      const all = await load();
      expect(all.total).toBe(18);
      expect(all.filtered).toBe(18);
      expect(all.rows, "a page of the queue, not all of it").toHaveLength(15);
      expect(all.matchingCampaigns).toBe(2);
      expect(all.bulk, "a decision across two campaigns' holds was offered as one").toBeNull();
      expect(new Map(all.campaigns.map((campaign) => [campaign.id, campaign.pending]))).toEqual(
        new Map([
          [campaignId, 17],
          [other.id, 1],
        ]),
      );

      // Pages through every one, once.
      const second = await load("page=2");
      expect(second.rows).toHaveLength(3);
      expect(new Set([...all.rows, ...second.rows].map((row) => row.variantGid)).size).toBe(18);

      const sale17 = await load(`campaign=${campaignId}`);
      expect([sale17.total, sale17.filtered]).toEqual([18, 17]);
      expect(sale17.bulk?.id).toBe(campaignId);

      const lowered = await load(`campaign=${campaignId}&direction=down`);
      expect([lowered.total, lowered.filtered]).toEqual([18, 9]);
      expect(lowered.rows.every((row) => row.direction === "down")).toBe(true);

      const raised = await load("direction=up");
      expect([raised.total, raised.filtered]).toEqual([18, 8]);
      // Every raised price is the sale's, so the decision is offered for it unasked.
      expect(raised.bulk?.id).toBe(campaignId);

      // Product: by title, by SKU, by the id in the admin's URL. `%` is a character, not a wildcard.
      for (const q of ["wool scarf", "scarf-blue", ours[3].split("/").pop()!, "100% wool"]) {
        const found = await load(`q=${encodeURIComponent(q)}`);
        expect(found.rows.map((row) => row.variantGid), q).toEqual([ours[3]]);
        expect(found.filtered).toBe(1);
      }
      expect((await load(`q=${encodeURIComponent("1%0")}`)).filtered).toBe(0);
    });
  });

  it("keeps exactly the filtered set, logs it as one entry, and releases the hold when nothing is left", async () => {
    await withChaos("drift-bulk-keep", { catalog: { products: 4, variantsPerProduct: 1 }, percent: -30 }, async (chaos) => {
      const { shopId, campaignId, variantGids } = chaos.fixture;
      const [raised, lowered1, lowered2, late] = variantGids;
      const sale = await applied(chaos);
      await edit(chaos, campaignId, raised, sale.get(raised)!, sale.get(raised)! + 200);
      await edit(chaos, campaignId, lowered1, sale.get(lowered1)!, sale.get(lowered1)! - 111);
      await edit(chaos, campaignId, lowered2, sale.get(lowered2)!, sale.get(lowered2)! - 222);
      expect(await statusOf(campaignId)).toBe("HELD");

      const page = await load(`campaign=${campaignId}&direction=down`);
      const kept = await decide({ resolution: "adopt", campaign: campaignId, direction: "down", asOf: page.asOf });
      expect(kept.ok, kept.message).toBe(true);
      expect(kept.message).toContain('Kept 2 changes as the new baseline for "');
      expect(kept.message).toContain("1 price still waits");

      const resolutions = await resolutionsOf(shopId);
      expect(resolutions.get(lowered1)).toBe("ADOPTED");
      expect(resolutions.get(lowered2)).toBe("ADOPTED");
      expect(resolutions.get(raised), "a price outside the filter was decided").toBe("PENDING");
      for (const gid of [lowered1, lowered2]) {
        const baseline = await prisma.baseline.findFirstOrThrow({ where: { shopId, variantGid: gid, supersededAt: null } });
        expect(Number(baseline.basePrice)).toBe(cents(chaos.fake.priceOf(gid)));
        expect(baseline.source).toBe("DRIFT_ADOPTION");
        expect(baseline.capturedBy).toBe(STAFF);
      }
      const untouched = await prisma.baseline.findFirstOrThrow({ where: { shopId, variantGid: raised, supersededAt: null } });
      expect(untouched.source).not.toBe("DRIFT_ADOPTION");

      // One entry for the decision, naming its variants -- not one per price.
      const entries = await bulkEntries(shopId, "drift.adopt");
      expect(entries).toHaveLength(1);
      expect(entries[0].actor).toBe(STAFF);
      expect(entries[0].entityId).toBe(campaignId);
      const after = entries[0].after as { prices: number; variantGids: string[]; stillWaiting: number; released: boolean };
      expect([...after.variantGids].sort()).toEqual([lowered1, lowered2].sort());
      expect(after).toMatchObject({ prices: 2, stillWaiting: 1, released: false });
      expect(await prisma.auditLogEntry.count({ where: { shopId, action: { startsWith: "drift." }, entity: "DriftEvent" } })).toBe(0);
      expect(await statusOf(campaignId), "released while an edit was still waiting").toBe("HELD");

      // The same decision again -- a double press -- changes nothing and writes nothing more.
      const again = await decide({ resolution: "adopt", campaign: campaignId, direction: "down", asOf: page.asOf });
      expect(again.message).toContain("Kept 2 changes");
      expect(await bulkEntries(shopId, "drift.adopt")).toHaveLength(1);

      // An edit made after the page loaded is not in a decision made from it.
      const before = await load(`campaign=${campaignId}`);
      await edit(chaos, campaignId, late, sale.get(late)!, sale.get(late)! + 5);
      const left = await decide({ resolution: "ignore", campaign: campaignId, asOf: before.asOf });
      expect(left.message).toContain(`Left 1 price for`);
      expect((await resolutionsOf(shopId)).get(raised)).toBe("IGNORED");
      expect((await resolutionsOf(shopId)).get(late), "an edit nobody had seen was decided").toBe("PENDING");
      expect(await statusOf(campaignId)).toBe("HELD");
      expect(chaos.fake.priceOf(raised), "Leave them for now changed a price").toBe(((sale.get(raised)! + 200) / 100).toFixed(2));

      const last = await load(`campaign=${campaignId}`);
      const done = await decide({ resolution: "ignore", campaign: campaignId, asOf: last.asOf });
      expect(done.message).toContain("is running again");
      expect(await statusOf(campaignId), "resolving the last of them left the campaign held").toBe("ACTIVE");
      expect(await bulkEntries(shopId, "drift.ignore")).toHaveLength(2);
    });
  });

  it("puts a filtered set back in one run for the campaign, read back clean", async () => {
    await withChaos("drift-bulk-put-back", { catalog: { products: 5, variantsPerProduct: 1 }, percent: -30 }, async (chaos) => {
      const { shopId, campaignId, variantGids } = chaos.fixture;
      const sale = await applied(chaos);
      const edited = variantGids.slice(0, 4);
      for (const gid of edited) await edit(chaos, campaignId, gid, sale.get(gid)!, sale.get(gid)! + 300);
      const runsBefore = await prisma.campaignRun.count({ where: { campaignId } });

      const page = await load(`campaign=${campaignId}`);
      const answer = await decide({ resolution: "reassert", campaign: campaignId, asOf: page.asOf });
      expect(answer.ok, answer.message).toBe(true);
      expect(answer.message).toContain("Put back 4 prices for");
      expect(enqueued, "four prices on four products fit the page's budget").toHaveLength(0);

      // One run, not one a row.
      const runs = await prisma.campaignRun.findMany({ where: { campaignId }, orderBy: { createdAt: "asc" } });
      expect(runs).toHaveLength(runsBefore + 1);
      const run = runs.at(-1)!;
      expect(run.occurrenceKey).toMatch(/^VARIANT-REASSERT-BATCH-/);
      const ledger = await prisma.variantChange.findMany({ where: { runId: run.id, surfaceKind: "BASE" } });
      expect(ledger.map((row) => [row.variantGid, row.status]).sort()).toEqual(edited.map((gid) => [gid, "VERIFIED"]).sort());
      for (const gid of edited) expect(cents(chaos.fake.priceOf(gid)), `${gid} is not back`).toBe(sale.get(gid));

      const resolutions = await resolutionsOf(shopId);
      for (const gid of edited) expect(resolutions.get(gid)).toBe("REASSERTED");
      expect(await statusOf(campaignId)).toBe("ACTIVE");
      await chaos.expectHonest(run.id);

      const [entry] = await bulkEntries(shopId, "drift.reassert");
      expect(entry.after).toMatchObject({ prices: 4, runId: run.id, released: true });
      expect([...(entry.after as { variantGids: string[] }).variantGids].sort()).toEqual([...edited].sort());
    });
  });

  it("leaves in the queue what it could not settle: an edit already gone, a write Shopify refused", async () => {
    await withChaos("drift-bulk-leftovers", { catalog: { products: 3, variantsPerProduct: 1 }, percent: -30 }, async (chaos) => {
      const { shopId, campaignId, variantGids, productOf } = chaos.fixture;
      const [gone, refused, fine] = variantGids;
      const sale = await applied(chaos);
      for (const gid of variantGids) await edit(chaos, campaignId, gid, sale.get(gid)!, sale.get(gid)! + 40);

      // Since the edit, something else wrote over it: there is no change left to keep (#755).
      await prisma.priceSurfaceEntry.updateMany({
        where: { shopId, variantGid: gone, surfaceKind: "BASE" },
        data: { livePrice: BigInt(sale.get(gone)! + 99) },
      });
      const page = await load(`campaign=${campaignId}`);
      const kept = await decide({ resolution: "adopt", campaign: campaignId, asOf: page.asOf });
      expect(kept.message).toContain("Kept 2 changes");
      expect(kept.message).toContain("1 price wasn't kept: the storefront no longer shows the edit");
      expect((await resolutionsOf(shopId)).get(gone)).toBe("PENDING");
      expect(await statusOf(campaignId)).toBe("HELD");

      // Put back, with Shopify refusing one product: the rest land, that one stays open.
      await prisma.driftEvent.updateMany({ where: { shopId }, data: { resolution: "PENDING", resolvedAt: null, resolvedBy: null } });
      await prisma.priceSurfaceEntry.updateMany({
        where: { shopId, variantGid: gone, surfaceKind: "BASE" },
        data: { livePrice: BigInt(sale.get(gone)! + 40) },
      });
      chaos.arm([
        {
          fault: "server-error",
          match: (query, variables) => isVariantWrite(query) && variables.productId === productOf.get(refused),
        },
      ]);
      const again = await load(`campaign=${campaignId}`);
      const putBack = await decide({ resolution: "reassert", campaign: campaignId, asOf: again.asOf });
      expect(putBack.ok).toBe(false);
      expect(putBack.message).toContain("Put back 2 prices for");
      expect(putBack.message).toContain("Shopify did not confirm 1 price, so it is still waiting");
      const resolutions = await resolutionsOf(shopId);
      expect(resolutions.get(refused), "a write Shopify refused was closed as put back").toBe("PENDING");
      expect(resolutions.get(gone)).toBe("REASSERTED");
      expect(resolutions.get(fine)).toBe("REASSERTED");
      expect(await statusOf(campaignId), "a failed put-back released the hold").toBe("HELD");
      expect(await prisma.campaignRun.count({ where: { campaignId, occurrenceKey: { startsWith: "VARIANT-REASSERT-BATCH-" } } })).toBe(1);
    });
  });

  it("hands a put-back too long for the page to the worker, which writes it as one run, once", async () => {
    await withChaos("drift-bulk-put-back-queued", { catalog: { products: 3, variantsPerProduct: 1 }, percent: -30 }, async (chaos) => {
      const { shopId, campaignId, variantGids } = chaos.fixture;
      const sale = await applied(chaos);
      for (const gid of variantGids) await edit(chaos, campaignId, gid, sale.get(gid)!, sale.get(gid)! - 77);
      limits.budgetMs = 1_000;

      const page = await load(`campaign=${campaignId}`);
      const answer = await decide({ resolution: "reassert", campaign: campaignId, asOf: page.asOf });
      expect(answer.ok, answer.message).toBe(true);
      expect(answer.message).toMatch(/Putting back 3 prices for ".*" in the background/);
      for (const gid of variantGids) expect(cents(chaos.fake.priceOf(gid)), "written inside the request anyway").toBe(sale.get(gid)! - 77);
      expect(enqueued).toHaveLength(1);
      expect(enqueued[0]).toMatchObject({ name: "execution", ref: { shopId, campaignId, actor: STAFF, drift: { resolution: "reassert" } } });

      // The page follows it.
      const waiting = await load(`campaign=${campaignId}&batch=${answer.batch}`);
      expect(waiting.status?.done).toBeNull();
      expect(waiting.status?.progress.started).toBe(false);

      const resent = enqueued[0];
      await runTheJobs();
      const runs = await prisma.campaignRun.findMany({ where: { campaignId, occurrenceKey: { startsWith: "VARIANT-REASSERT-BATCH-" } } });
      expect(runs).toHaveLength(1);
      expect(runs[0].status).toBe("COMPLETED");
      for (const gid of variantGids) expect(cents(chaos.fake.priceOf(gid))).toBe(sale.get(gid));
      expect(await statusOf(campaignId)).toBe("ACTIVE");
      await chaos.expectHonest(runs[0].id);

      const finished = await load(`campaign=${campaignId}&batch=${answer.batch}`);
      expect(finished.status?.done?.resolved).toBe(3);

      // The same job delivered twice writes nothing more and records nothing more.
      enqueued.push(resent);
      await runTheJobs();
      expect(await prisma.campaignRun.count({ where: { campaignId, occurrenceKey: { startsWith: "VARIANT-REASSERT-BATCH-" } } })).toBe(1);
      expect(await bulkEntries(shopId, "drift.reassert")).toHaveLength(1);
    });
  });

  it("puts back over a thousand prices as one bulk operation, in the worker", async () => {
    // The ticket's own case: a thousand-odd drifted prices on one campaign. Past the bulk
    // threshold the run is one Shopify bulk operation, which no request can wait on.
    await withChaos(
      "drift-bulk-put-back-at-scale",
      { catalog: { products: 7, variantsPerProduct: 150 }, percent: -20, pollsBeforeComplete: 1 },
      async (chaos) => {
        const { shopId, campaignId, variantGids } = chaos.fixture;
        const sale = await applied(chaos);

        // Every price edited a cent down, as one bulk edit in the admin would leave them.
        for (const gid of variantGids) chaos.fake.variants.get(gid)!.price = ((sale.get(gid)! - 1) / 100).toFixed(2);
        await prisma.$executeRaw`UPDATE "price_surface_entries" SET "livePrice" = "livePrice" - 1 WHERE "shopId" = ${shopId} AND "surfaceKind" = 'BASE'`;
        await prisma.driftEvent.createMany({
          data: variantGids.map((gid) => ({
            shopId,
            variantGid: gid,
            surfaceKind: "BASE" as const,
            campaignId,
            observedPrice: BigInt(sale.get(gid)! - 1),
            expectedPrice: BigInt(sale.get(gid)!),
            currency: "USD",
          })),
        });
        await holdForDrift(shopId, campaignId, variantGids[0]);

        const page = await load(`campaign=${campaignId}&direction=down`);
        expect(page.filtered).toBe(1_050);
        const answer = await decide({ resolution: "reassert", campaign: campaignId, direction: "down", asOf: page.asOf });
        expect(answer.message).toMatch(/Putting back 1,050 prices for ".*" in the background/);
        expect(enqueued).toHaveLength(1);

        await runTheJobs();
        const runs = await prisma.campaignRun.findMany({ where: { campaignId, occurrenceKey: { startsWith: "VARIANT-REASSERT-BATCH-" } } });
        expect(runs).toHaveLength(1);
        expect(await prisma.bulkOperationRecord.count({ where: { runId: runs[0].id, kind: "MUTATION" } }), "not one bulk operation").toBe(1);
        await chaos.expectHonest(runs[0].id);
        for (const gid of variantGids) expect(cents(chaos.fake.priceOf(gid)), `${gid} is not back`).toBe(sale.get(gid));
        expect(await prisma.driftEvent.count({ where: { shopId, resolution: "REASSERTED" } })).toBe(1_050);
        expect(await statusOf(campaignId)).toBe("ACTIVE");

        const [entry] = await bulkEntries(shopId, "drift.reassert");
        expect((entry.after as { variantGids: string[] }).variantGids).toHaveLength(1_050);
      },
    );
  });

  it("hands a large keep to the worker, and the page follows it to the end", async () => {
    await withChaos("drift-bulk-keep-queued", { catalog: { products: 3, variantsPerProduct: 1 }, percent: -30 }, async (chaos) => {
      const { shopId, campaignId, variantGids } = chaos.fixture;
      const sale = await applied(chaos);
      for (const gid of variantGids) await edit(chaos, campaignId, gid, sale.get(gid)!, sale.get(gid)! + 1);
      limits.inlineRows = 2;

      const page = await load(`campaign=${campaignId}`);
      const answer = await decide({ resolution: "adopt", campaign: campaignId, asOf: page.asOf });
      expect(answer.message).toMatch(/Keeping 3 changes for ".*" in the background/);
      expect(await prisma.driftEvent.count({ where: { shopId, resolution: "PENDING" } }), "kept inside the request anyway").toBe(3);

      const following = await load(`campaign=${campaignId}&batch=${answer.batch}`);
      expect(following.status?.done).toBeNull();
      expect(following.status?.progress.done).toBe(0);

      await runTheJobs();
      expect(await prisma.driftEvent.count({ where: { shopId, resolution: "ADOPTED" } })).toBe(3);
      expect(await statusOf(campaignId)).toBe("ACTIVE");
      const done = await load(`batch=${answer.batch}`);
      expect(done.total).toBe(0);
      expect(done.status?.done?.resolved).toBe(3);
      expect(await bulkEntries(shopId, "drift.adopt")).toHaveLength(1);
    });
  });

  it("exports every drifted price the filters match, not the fifteen on screen", async () => {
    await withChaos("drift-bulk-export", { catalog: { products: 20, variantsPerProduct: 1 }, percent: -30 }, async (chaos) => {
      const { campaignId, variantGids } = chaos.fixture;
      const sale = await applied(chaos);
      for (const [index, gid] of variantGids.entries()) {
        await edit(chaos, campaignId, gid, sale.get(gid)!, sale.get(gid)! + (index < 12 ? 10 : -10));
      }
      expect((await load()).rows).toHaveLength(15);

      const { loader } = await import("../../app/routes/app.export.$kind");
      const exported = async (query: string) => {
        const response = (await loader({
          request: new Request(`https://example.invalid/app/export/drift?${query}`),
          params: { kind: "drift" },
          context: {},
        } as never)) as Response;
        expect(response.status).toBe(200);
        return (await response.text()).trim().split("\n");
      };

      const every = await exported(`campaign=${campaignId}`);
      expect(every[0]).toContain('"Campaign set","Now shows","Currency","Direction"');
      expect(every.slice(1).map((line) => line.split(",")[0].replace(/"/g, "")).sort()).toEqual([...variantGids].sort());

      const raised = await exported(`campaign=${campaignId}&direction=up`);
      expect(raised).toHaveLength(1 + 12);
      expect(raised.slice(1).every((line) => line.includes('"Raised"'))).toBe(true);
    });
  });
});
