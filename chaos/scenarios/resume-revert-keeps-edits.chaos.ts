/**
 * Resuming a revert that kept a hand edit keeps it (#1157).
 *
 * A revert can leave a price alone so a merchant's edit stays live: a row ticked "Leave as
 * it is" on the Revert tab, an edit a held sale's scheduled end kept (#784), or one Flow's
 * End campaign kept (#794). Each is ledgered as spared, with its reason. When that revert
 * stopped part-way, the campaign page offered Resume, and Flow's answer said "Resume it from
 * the campaign page". The Resume form posts only `intent=resume`, and a resumed revert
 * planned the whole revert again with nothing to leave alone, so it wrote the campaign-free
 * price over every edit the revert had kept. The scheduler's next attempt at a scheduled end
 * did the same, unasked.
 *
 * Driven through the routes' own actions: every edit arrives through the products webhook,
 * Flow through its action route, Revert and Resume through the campaign page's action and
 * the scheduler through the real `tick`. Only `authenticate` and the admin client are
 * replaced, and there is no worker queue, so everything runs in the request.
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { KEPT_EDIT_REASON } from "../../app/lib/campaigns/kept-edits";
import { rollbackReport } from "../../app/services/campaigns/rollback-report.server";
import { tick } from "../../app/services/scheduler.server";
import { ringQueuedRuns, STRANDED_RUN_AFTER_MS } from "../../app/services/campaigns/queued-run.server";
import { inlineRuntime } from "../../app/worker/queue-runtime.server";
import type { JobRef, QueueName } from "../../app/worker/queues";
import { isVariantWrite } from "../harness/faults";
import { chaosAdminClient } from "../harness/http-client";
import { type ChaosContext, fixtureAdminClient, withChaos } from "../harness/scenario";

let shop = "";
let endpoint = "";
let webhook: { shop: string; topic: string; payload: unknown; admin?: unknown } = { shop: "", topic: "", payload: {} };

vi.mock("../../app/shopify.server", () => ({
  authenticate: {
    admin: async () => ({ session: { shop }, sessionToken: { sub: "42" }, admin: { __chaos: chaosAdminClient(endpoint) } }),
    flow: async () => ({ session: { shop }, payload: { properties: { "campaign-id": flowCampaign } }, admin: { __chaos: chaosAdminClient(endpoint) } }),
    webhook: async () => webhook,
  },
}));
let flowCampaign = "";

vi.mock("../../app/services/admin-client.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/services/admin-client.server")>();
  return {
    ...actual,
    adminClientForShop: async (domain: string) => fixtureAdminClient(domain, endpoint),
    toAdminClient: (admin: unknown) => (admin as { __chaos?: unknown })?.__chaos ?? actual.toAdminClient(admin as never),
  };
});

// No worker queue: the webhook is handled in the request, and so is every run the page writes
// while it waits. What Flow starts is the worker's (D29): its tick runs it (`worker` below).
vi.mock("../../app/worker/web-queue.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../app/worker/web-queue.server")>()),
  webQueue: () => null,
}));

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
}

/** A press on the campaign page, as its forms post it. */
async function press(chaos: ChaosContext, intent: string, keep: string[] = []) {
  const { campaignId } = chaos.fixture;
  const { action } = await import("../../app/routes/app.campaigns.$id");
  const body = new FormData();
  body.set("intent", intent);
  for (const gid of keep) body.append("keep", gid);
  const response = await action({
    request: new Request(`https://example.invalid/app/campaigns/${campaignId}`, { method: "POST", body }),
    params: { id: campaignId },
    context: {},
  } as never);
  return (response instanceof Response ? await response.json() : response) as { ok: boolean; message: string; details: string[] };
}

/** What the campaign page shows a Partial campaign above its Resume button. */
async function banner(chaos: ChaosContext) {
  const { campaignId } = chaos.fixture;
  const { loader } = await import("../../app/routes/app.campaigns.$id");
  const page = (await loader({
    request: new Request(`https://example.invalid/app/campaigns/${campaignId}`),
    params: { id: campaignId },
    context: {},
  } as never)) as { lifecycle: { explanation: string; nextAction?: { label: string } } };
  return page.lifecycle;
}

/** Flow's End a price campaign, through its route. */
async function flowEnds(chaos: ChaosContext) {
  flowCampaign = chaos.fixture.campaignId;
  const { action } = await import("../../app/routes/flow.actions.end-campaign");
  const response = (await action({
    request: new Request("https://example.invalid/flow/actions/end-campaign", { method: "POST" }),
    params: {},
    context: {},
  } as never)) as Response;
  return ((await response.json()) as { message: string }).message;
}

/** The worker's tick, with no Redis of its own: it runs what Flow queued. */
async function worker(chaos: ChaosContext) {
  const handle = async (name: QueueName, ref: JobRef) => (await import("../../app/worker/handlers.server")).handleJob(name, ref);
  const now = new Date(Date.now() + STRANDED_RUN_AFTER_MS + 1_000);
  await ringQueuedRuns(inlineRuntime(handle), handle, { now, shopId: chaos.fixture.shopId });
}

/** Fails every price write to this variant's product, so a revert over it stops part-way. */
function breakWritesTo(chaos: ChaosContext, variantGid: string) {
  const productGid = chaos.fixture.productOf.get(variantGid)!;
  chaos.arm([{ fault: "server-error", match: (query, variables) => isVariantWrite(query) && variables.productId === productGid }]);
}

/** A sale whose window has closed, so its scheduled end is due on the next tick. */
async function windowEnded(campaignId: string) {
  const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
  const startAt = new Date(Date.now() - 2 * 60 * 60_000);
  const endAt = new Date(Date.now() - 60 * 60_000);
  await prisma.campaign.update({
    where: { id: campaignId },
    data: {
      startAt,
      endAt,
      schedule: { ...(campaign.schedule as object), kind: "window", startAt: startAt.toISOString(), endAt: endAt.toISOString() } as never,
    },
  });
}

const statusOf = async (id: string) => (await prisma.campaign.findUniqueOrThrow({ where: { id } })).status;

/** The newest step of "How it got here": the move the run made, and why. */
async function lastTransition(shopId: string, campaignId: string) {
  const entry = await prisma.auditLogEntry.findFirstOrThrow({
    where: { shopId, entityId: campaignId, action: "campaign.transition" },
    orderBy: { createdAt: "desc" },
  });
  return entry.after as { status?: string; reason?: string };
}
const cents = (chaos: ChaosContext, gid: string) => Number(chaos.fake.priceOf(gid)!.replace(".", ""));

/** A held sale: applied, then one price edited by hand to 1.23. */
async function heldByOneEdit(chaos: ChaosContext) {
  shop = chaos.fixture.domain;
  endpoint = chaos.server.endpoint();
  await chaos.expectHonest((await chaos.apply()).runId);
  const [edited, stuck, ...rest] = chaos.fixture.variantGids;
  await merchantEdits(chaos, edited, "1.23");
  expect(await statusOf(chaos.fixture.campaignId)).toBe("HELD");
  return { edited, stuck, rest };
}

/** The revert stopped part-way: the edit kept, the broken product still on sale. */
async function expectStoppedKeepingEdit(chaos: ChaosContext, edited: string, stuck: string, sale: number) {
  expect(await statusOf(chaos.fixture.campaignId)).toBe("PARTIAL");
  expect(chaos.fake.priceOf(edited), "the revert wrote over the edit it was keeping").toBe("1.23");
  expect(cents(chaos, stuck), "the broken product was reverted after all").toBe(sale);
}

/** Every other price back at baseline, the edit still live, and the campaign ended. */
async function expectFinishedKeepingEdit(chaos: ChaosContext, edited: string, reason: string | RegExp) {
  const { shopId, campaignId, variantGids, baseline } = chaos.fixture;
  expect(chaos.fake.priceOf(edited), "Resume wrote over the edit the revert kept").toBe("1.23");
  for (const gid of variantGids.filter((gid) => gid !== edited)) {
    expect(cents(chaos, gid), `${gid} not back at baseline`).toBe(baseline.get(gid));
  }
  expect(await statusOf(campaignId)).toBe("COMPLETED");
  expect(await prisma.auditLogEntry.count({ where: { shopId, action: "drift.overwritten" } })).toBe(0);

  // Ledgered again by the run that finished, with the reason it was first kept for, so a
  // later revert -- and the Ledger tab -- reads it from the newest run as well.
  const resumed = await prisma.campaignRun.findFirstOrThrow({ where: { campaignId, kind: "REVERT" }, orderBy: { createdAt: "desc" } });
  const kept = await prisma.variantChange.findFirstOrThrow({ where: { runId: resumed.id, variantGid: edited, surfaceKind: "BASE" } });
  expect(kept.status).toBe("SKIPPED");
  if (typeof reason === "string") expect(kept.failureReason).toBe(reason);
  else expect(kept.failureReason).toMatch(reason);
}

/** The banner's sentence for one kept edit. */
const KEPT_ONE = /1 price edited outside Anchor that the revert kept stays as edited: Resume leaves it alone\.$/;

const CATALOG = { catalog: { products: 3, variantsPerProduct: 1 }, percent: -20 } as const;

describe("chaos: Resume after a revert that kept an edit stopped part-way", () => {
  it("keeps an edit ticked \"Leave as it is\" on the Revert tab, and finishes the rest", async () => {
    await withChaos("resume-keeps-revert-tab-edit", CATALOG, async (chaos) => {
      const { edited, stuck } = await heldByOneEdit(chaos);
      const sale = cents(chaos, stuck);

      breakWritesTo(chaos, stuck);
      await press(chaos, "revert", [edited]);
      await expectStoppedKeepingEdit(chaos, edited, stuck, sale);

      // What the page says beside the button, before it is pressed.
      const lifecycle = await banner(chaos);
      expect(lifecycle.nextAction?.label).toBe("Resume revert");
      expect(lifecycle.explanation).toMatch(/Resuming finishes the revert\. 1 price edited outside Anchor that the revert kept stays as edited: Resume leaves it alone\.$/);
      // Revert pressed again is a new answer, not a resume: the Revert tab asks about it again.
      const { shopId, campaignId } = chaos.fixture;
      expect((await rollbackReport(shopId, campaignId)).rows.find((row) => row.variantGid === edited)?.kind).toBe("drifted");

      // Resumed while the product is still broken: Partial again, and the edit still kept, so
      // the next Resume reads it from this run's ledger.
      await press(chaos, "resume");
      await expectStoppedKeepingEdit(chaos, edited, stuck, sale);
      expect((await banner(chaos)).explanation).toMatch(KEPT_ONE);

      chaos.heal();
      const resumed = await press(chaos, "resume");

      expect(resumed.ok).toBe(true);
      expect(resumed.details).toContain("1 price edited outside Anchor was left as edited, not reverted.");
      await expectFinishedKeepingEdit(chaos, edited, "Left as it is: this price was changed outside the app and you chose to keep that edit.");
      expect((await lastTransition(shopId, campaignId)).reason).toMatch(
        /^revert finished: 1 verified, 0 failed\. 1 price edited outside Anchor was left as edited, not reverted\.$/,
      );
    });
  });

  it("keeps an edit a held sale's scheduled end kept, when the merchant resumes it", async () => {
    await withChaos("resume-keeps-scheduled-end-edit", CATALOG, async (chaos) => {
      const { edited, stuck } = await heldByOneEdit(chaos);
      const sale = cents(chaos, stuck);
      await windowEnded(chaos.fixture.campaignId);

      breakWritesTo(chaos, stuck);
      await tick(new Date());
      await expectStoppedKeepingEdit(chaos, edited, stuck, sale);
      expect((await banner(chaos)).explanation).toMatch(KEPT_ONE);

      chaos.heal();
      await press(chaos, "resume");

      await expectFinishedKeepingEdit(chaos, edited, /edited outside the app while the campaign was held.*waiting for your decision/);
      // Still the merchant's to decide.
      const event = await prisma.driftEvent.findFirstOrThrow({ where: { shopId: chaos.fixture.shopId, variantGid: edited } });
      expect(event.resolution).toBe("PENDING");
    });
  });

  it("keeps it when the scheduler's next attempt at the end finishes the revert, unasked", async () => {
    await withChaos("resume-keeps-scheduled-retry-edit", CATALOG, async (chaos) => {
      const { edited, stuck } = await heldByOneEdit(chaos);
      const sale = cents(chaos, stuck);
      await windowEnded(chaos.fixture.campaignId);

      breakWritesTo(chaos, stuck);
      await tick(new Date());
      await expectStoppedKeepingEdit(chaos, edited, stuck, sale);

      // Nobody presses anything: the next tick tries the end again.
      chaos.heal();
      await tick(new Date());

      await expectFinishedKeepingEdit(chaos, edited, /edited outside the app while the campaign was held.*waiting for your decision/);
    });
  });

  it("keeps an edit Flow's End campaign kept, when Flow's answer sends the merchant to Resume", async () => {
    await withChaos("resume-keeps-flow-end-edit", CATALOG, async (chaos) => {
      const { edited, stuck } = await heldByOneEdit(chaos);
      const sale = cents(chaos, stuck);

      breakWritesTo(chaos, stuck);
      // Queued, whatever its size (D29), and told what the worker will do with the edits.
      const answer = await flowEnds(chaos);
      expect(answer).toMatch(/background worker is reverting it.*edited outside Anchor/);
      await worker(chaos);
      await expectStoppedKeepingEdit(chaos, edited, stuck, sale);
      expect((await banner(chaos)).explanation).toMatch(KEPT_ONE);

      chaos.heal();
      await press(chaos, "resume");

      await expectFinishedKeepingEdit(chaos, edited, KEPT_EDIT_REASON);
    });
  });

  it("counts the edit it kept, not a variant deleted while the revert ran", async () => {
    await withChaos("resume-keeps-edit-not-deleted", { ...CATALOG, catalog: { products: 4, variantsPerProduct: 1 } }, async (chaos) => {
      const { edited, stuck, rest } = await heldByOneEdit(chaos);
      const sale = cents(chaos, stuck);
      // Gone from Shopify, still in the mirror: the revert sends it, and ledgers it SKIPPED (E4).
      const deleted = rest[0];
      chaos.fake.deleteVariant(deleted);

      breakWritesTo(chaos, stuck);
      await press(chaos, "revert", [edited]);
      await expectStoppedKeepingEdit(chaos, edited, stuck, sale);
      const revert = await prisma.campaignRun.findFirstOrThrow({ where: { campaignId: chaos.fixture.campaignId, kind: "REVERT" } });
      expect((await prisma.variantChange.findFirstOrThrow({ where: { runId: revert.id, variantGid: deleted } })).status).toBe("SKIPPED");
      // Two skipped rows, one kept edit.
      expect((await banner(chaos)).explanation).toMatch(KEPT_ONE);

      chaos.heal();
      const resumed = await press(chaos, "resume");

      expect(resumed.details).toContain("1 price edited outside Anchor was left as edited, not reverted.");
      expect(chaos.fake.priceOf(edited), "Resume wrote over the edit the revert kept").toBe("1.23");
      expect(cents(chaos, stuck)).toBe(chaos.fixture.baseline.get(stuck));
      expect(await statusOf(chaos.fixture.campaignId)).toBe("COMPLETED");
      // Not dressed up as a kept edit on the resumed run.
      const last = await prisma.campaignRun.findFirstOrThrow({ where: { campaignId: chaos.fixture.campaignId, kind: "REVERT" }, orderBy: { createdAt: "desc" } });
      const row = await prisma.variantChange.findFirst({ where: { runId: last.id, variantGid: deleted } });
      expect(row?.failureReason ?? "").not.toMatch(/^Left as it is/);
    });
  });
});
