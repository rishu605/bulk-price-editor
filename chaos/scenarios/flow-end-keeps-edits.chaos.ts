/**
 * Flow's End campaign keeps the prices a merchant edited by hand (#794).
 *
 * Reproduced on DartMode Labs: a sale's price set by hand to 699.00 held the campaign, and
 * the campaign page offered only "Review 1 edited before reverting", deliberately no Revert.
 * A Flow workflow's End a price campaign then reverted it straight over the edit, to 885.95,
 * and the drift queue went on offering "Keep the change" for a price that was gone.
 *
 * Driven through the routes' own actions: every edit arrives through the products webhook,
 * and Flow through its action route, with only `authenticate` replaced. The web queue is
 * off while an edit is delivered, so the webhook is handled in the request, and a recorder
 * while Flow asks, so a large end is handed over and then run by the worker's own handler.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { KEPT_EDIT_REASON } from "../../app/lib/campaigns/kept-edits";
import { rollbackReport } from "../../app/services/campaigns/rollback-report.server";
import { resolveDrift } from "../../app/services/drift.server";
import { ringQueuedRuns, STRANDED_RUN_AFTER_MS } from "../../app/services/campaigns/queued-run.server";
import { inlineRuntime } from "../../app/worker/queue-runtime.server";
import type { JobRef, QueueName } from "../../app/worker/queues";
import { chaosAdminClient } from "../harness/http-client";
import { type ChaosContext, fixtureAdminClient, withChaos } from "../harness/scenario";

let flowRequest: { shop: string; properties: Record<string, string>; admin?: unknown } = { shop: "", properties: {} };
let webhook: { shop: string; topic: string; payload: unknown; admin?: unknown } = { shop: "", topic: "", payload: {} };
let endpoint = "";
let queueOn = false;
const enqueued: Array<{ name: QueueName; ref: JobRef }> = [];

vi.mock("../../app/shopify.server", () => ({
  authenticate: {
    flow: async () => ({ session: { shop: flowRequest.shop }, payload: { properties: flowRequest.properties }, admin: flowRequest.admin }),
    webhook: async () => webhook,
  },
}));

vi.mock("../../app/services/admin-client.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/services/admin-client.server")>();
  return {
    ...actual,
    adminClientForShop: async (domain: string) => fixtureAdminClient(domain, endpoint),
    toAdminClient: (admin: unknown) =>
      (admin as { __chaos?: unknown })?.__chaos ?? actual.toAdminClient(admin as never),
  };
});

vi.mock("../../app/worker/web-queue.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../app/worker/web-queue.server")>()),
  webQueue: () =>
    queueOn
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

beforeEach(() => {
  enqueued.length = 0;
  queueOn = false;
});

const webhookAdmin = {
  async graphql(_query: string, options?: { variables?: Record<string, unknown> }) {
    return { json: async () => ({ data: { product: { id: options?.variables?.id, isGiftCard: false } } }) };
  },
};

let clock = 60_000;

/** A merchant's edit in the Shopify admin: the store changes, then the webhook lands. */
async function merchantEdits(chaos: ChaosContext, variantGid: string, price: string) {
  chaos.fake.variants.get(variantGid)!.price = price;
  clock += 60_000;
  webhook = {
    shop: chaos.fixture.domain,
    topic: "PRODUCTS_UPDATE",
    admin: webhookAdmin,
    payload: {
      admin_graphql_api_id: chaos.fixture.productOf.get(variantGid)!,
      title: "Edited product",
      status: "active",
      // The seeded campaign selects on this tag. A real edit keeps the product's tags.
      tags: "chaos",
      updated_at: new Date(Date.now() + clock).toISOString(),
      variants: [{ admin_graphql_api_id: variantGid, title: "V", price, compare_at_price: null }],
      variant_gids: [{ admin_graphql_api_id: variantGid }],
    },
  };
  const { action } = await import("../../app/routes/webhooks.products");
  await action({ request: new Request("https://example.invalid/webhooks/products", { method: "POST" }) } as never);
  return prisma.driftEvent.findFirstOrThrow({ where: { shopId: chaos.fixture.shopId, variantGid, resolution: "PENDING" } });
}

/** Flow's End a price campaign, through its route, with the web queue as `queue` says. */
async function flowEnds(chaos: ChaosContext, { queue }: { queue: boolean }) {
  endpoint = chaos.server.endpoint();
  flowRequest = { shop: chaos.fixture.domain, properties: { "campaign-id": chaos.fixture.campaignId }, admin: { __chaos: chaosAdminClient(endpoint) } };
  queueOn = queue;
  const { action } = await import("../../app/routes/flow.actions.end-campaign");
  const response = (await action({
    request: new Request("https://example.invalid/flow/actions/end-campaign", { method: "POST" }),
    params: {},
    context: {},
  } as never)) as Response;
  queueOn = false;
  return { status: response.status, message: ((await response.json()) as { message: string }).message };
}

/**
 * The worker's tick, with no Redis of its own, running what Flow queued: every end Flow asks
 * for is the worker's since D29 (#808), however small.
 */
async function worker(chaos: ChaosContext) {
  const handle = async (name: QueueName, ref: JobRef) => (await import("../../app/worker/handlers.server")).handleJob(name, ref);
  const now = new Date(Date.now() + STRANDED_RUN_AFTER_MS + 1_000);
  expect(await ringQueuedRuns(inlineRuntime(handle), handle, { now, shopId: chaos.fixture.shopId })).toBe(1);
}

const statusOf = async (id: string) => (await prisma.campaign.findUniqueOrThrow({ where: { id } })).status;
const cents = (chaos: ChaosContext, gid: string) => Number(chaos.fake.priceOf(gid)!.replace(".", ""));

/** The newest step of "How it got here": the move the end made, and why. */
async function lastTransition(shopId: string, campaignId: string) {
  const entry = await prisma.auditLogEntry.findFirstOrThrow({
    where: { shopId, entityId: campaignId, action: "campaign.transition" },
    orderBy: { createdAt: "desc" },
  });
  return entry.after as { status?: string; reason?: string };
}

/** What the end did to the edited variant and the rest, read from the store and the ledger. */
async function expectEditKept(chaos: ChaosContext, edited: string, price: string) {
  const { shopId, campaignId, variantGids, baseline } = chaos.fixture;
  expect(chaos.fake.priceOf(edited), "Flow's end wrote over the merchant's edit").toBe(price);
  for (const gid of variantGids.filter((gid) => gid !== edited)) {
    expect(cents(chaos, gid), `${gid} not back at baseline`).toBe(baseline.get(gid));
  }
  expect(await statusOf(campaignId)).toBe("COMPLETED");

  const revert = await prisma.campaignRun.findFirstOrThrow({ where: { campaignId, kind: "REVERT" }, orderBy: { createdAt: "desc" } });
  const kept = await prisma.variantChange.findFirstOrThrow({ where: { runId: revert.id, variantGid: edited, surfaceKind: "BASE" } });
  expect(kept.status).toBe("SKIPPED");
  expect(kept.failureReason).toBe(KEPT_EDIT_REASON);

  // Nothing was written over it, so nothing says it was.
  expect(await prisma.auditLogEntry.count({ where: { shopId, action: "drift.overwritten" } })).toBe(0);
  const history = await lastTransition(shopId, campaignId);
  expect(history.status).toBe("COMPLETED");
  expect(history.reason).toMatch(/^revert finished: \d+ verified, 0 failed\. 1 price edited outside Anchor was left as edited, not reverted\.$/);
}

const SMALL = { catalog: { products: 2, variantsPerProduct: 1 }, percent: -20 } as const;
const LARGE = { catalog: { products: 20, variantsPerProduct: 1 }, percent: -20 } as const;

describe("chaos: Flow's End campaign over a price edited by hand", () => {
  it("keeps the edit that held the campaign, reverts the rest, and says so", async () => {
    await withChaos("flow-end-keeps-held-edit", SMALL, async (chaos) => {
      const { shopId, campaignId, variantGids } = chaos.fixture;
      const [edited, other] = variantGids;
      endpoint = chaos.server.endpoint();
      await chaos.expectHonest((await chaos.apply()).runId);

      const event = await merchantEdits(chaos, edited, "1.23");
      expect(await statusOf(campaignId)).toBe("HELD");
      // What the campaign page refuses to revert over with one click.
      expect((await rollbackReport(shopId, campaignId)).counts.drifted).toBe(1);

      const answer = await flowEnds(chaos, { queue: false });

      // Queued, two products or twenty thousand (D29), and told what happens to the edits.
      expect(answer.status).toBe(200);
      expect(answer.message).toMatch(/^"chaos\/flow-end-keeps-held-edit": Runs started from Shopify Flow are always written by the background worker\./);
      expect(answer.message).toMatch(/Any price edited outside Anchor since the campaign set it is left as edited, not reverted\.$/);
      await worker(chaos);
      expect(chaos.fake.priceOf(edited), "Flow's end wrote over the merchant's edit").toBe("1.23");
      await expectEditKept(chaos, edited, "1.23");
      expect(cents(chaos, other)).toBe(chaos.fixture.baseline.get(other));

      // Still the merchant's to decide, and what the drift queue shows is what the store shows.
      const after = await prisma.driftEvent.findUniqueOrThrow({ where: { id: event.id } });
      expect(after.resolution).toBe("PENDING");
      expect(Number(after.observedPrice)).toBe(123);
      const mirror = await prisma.priceSurfaceEntry.findFirstOrThrow({ where: { shopId, variantGid: edited, surfaceKind: "BASE", priceListGid: "" } });
      expect(Number(mirror.livePrice)).toBe(123);

      const [request] = await prisma.auditLogEntry.findMany({ where: { shopId, actor: "shopify-flow", action: "flow.end-campaign" } });
      expect(request.after).toMatchObject({ outcome: "queued", status: 200, message: answer.message });
    });
  });

  it("keeps an edit left for now in the drift queue, which no pending drift event names", async () => {
    await withChaos("flow-end-keeps-left-edit", SMALL, async (chaos) => {
      const { shopId, campaignId, variantGids } = chaos.fixture;
      const [edited] = variantGids;
      endpoint = chaos.server.endpoint();
      await chaos.expectHonest((await chaos.apply()).runId);

      // "Leave it for now": the alert closes, the campaign runs again, the edit stays live.
      const event = await merchantEdits(chaos, edited, "1.23");
      await resolveDrift(shopId, event.id, "ignore", "staff@example.com");
      expect(await statusOf(campaignId)).toBe("ACTIVE");
      expect(await prisma.driftEvent.count({ where: { shopId, campaignId, resolution: "PENDING" } })).toBe(0);
      // The Revert tab still asks about it, so Flow must not write over it either.
      expect((await rollbackReport(shopId, campaignId)).rows.find((row) => row.variantGid === edited)?.kind).toBe("drifted");

      const answer = await flowEnds(chaos, { queue: false });

      expect(answer.status).toBe(200);
      expect(answer.message).toContain("is left as edited, not reverted.");
      await worker(chaos);
      expect(chaos.fake.priceOf(edited), "Flow's end wrote over an edit the merchant left for now").toBe("1.23");
      await expectEditKept(chaos, edited, "1.23");
    });
  });

  it("hands a large held campaign to the worker, which keeps the edit when it runs", async () => {
    await withChaos("flow-end-keeps-edit-queued", LARGE, async (chaos) => {
      const { shopId, campaignId, variantGids, baseline } = chaos.fixture;
      const [edited] = variantGids;
      endpoint = chaos.server.endpoint();
      await chaos.expectHonest((await chaos.apply()).runId);
      const sale = new Map(variantGids.map((gid) => [gid, cents(chaos, gid)]));

      await merchantEdits(chaos, edited, "1.23");
      expect(await statusOf(campaignId)).toBe("HELD");

      const answer = await flowEnds(chaos, { queue: true });

      expect(answer.status).toBe(200);
      expect(answer.message).toMatch(/background worker is reverting it/);
      expect(answer.message).toMatch(/Any price edited outside Anchor since the campaign set it is left as edited, not reverted\.$/);
      expect(enqueued).toEqual([
        {
          name: "execution",
          ref: {
            shopId,
            campaignId,
            runId: expect.any(String),
            revert: true,
            claimedFrom: "HELD",
            actor: "shopify-flow",
            keepEdited: true,
            skipReason: KEPT_EDIT_REASON,
          },
        },
      ]);
      expect(await statusOf(campaignId)).toBe("REVERTING");
      // Nothing written by the request.
      for (const gid of variantGids.slice(1)) expect(cents(chaos, gid)).toBe(sale.get(gid));

      const { handleJob } = await import("../../app/worker/handlers.server");
      await handleJob(enqueued[0].name, enqueued[0].ref);

      await expectEditKept(chaos, edited, "1.23");
      expect(cents(chaos, variantGids[1])).toBe(baseline.get(variantGids[1]));
    });
  });
});
