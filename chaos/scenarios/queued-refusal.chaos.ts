/**
 * A run handed to the background worker and refused before it wrote says so (#1046).
 *
 * Flow's start of a campaign larger than its ten seconds is claimed, queued and answered
 * "the background worker is applying it". The worker's run could still be refused: by a
 * blocking guardrail, which only planning the whole campaign finds, or by a change made while
 * the job waited. That refusal reached only the campaign's history -- no email, nothing on
 * the Status card or in the list, and Flow's run log still said queued.
 *
 * What can be checked before answering Flow is: a campaign whose segment is already gone is
 * refused there, and the refusal is in Flow's run log.
 *
 * Driven through Flow's Start action, the worker's own `handleJob`, the campaign page's
 * loader and the list. Replaced: `authenticate`, `adminClientForShop` (the fixture shop has
 * no session), `notify` (a recorder) and the web queue (a recorder).
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { queuedRefusal } from "../../app/lib/campaigns/queued-refusal";
import type { Notification } from "../../app/lib/notifications/templates";
import { filtersFrom, listCampaigns } from "../../app/services/campaigns/list.server";
import { createSegment } from "../../app/services/segments-crud.server";
import { DEFAULT_SETTINGS, writeSettings } from "../../app/services/settings.server";
import type { JobRef, QueueName } from "../../app/worker/queues";
import { redefine } from "../harness/definition";
import { chaosAdminClient, chaosAdminContext } from "../harness/http-client";
import { type ChaosContext, fixtureAdminClient, withChaos } from "../harness/scenario";

let pending: { shop: string; properties: Record<string, string> } = { shop: "", properties: {} };
let endpoint = "";

vi.mock("../../app/shopify.server", () => ({
  authenticate: {
    admin: async () => ({ session: { shop: pending.shop }, sessionToken: { sub: "42" }, admin: chaosAdminContext(endpoint) }),
    flow: async () => ({
      session: { shop: pending.shop },
      payload: { properties: pending.properties },
      admin: { __chaos: chaosAdminClient(endpoint) },
    }),
  },
}));

vi.mock("../../app/services/admin-client.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/services/admin-client.server")>();
  return {
    ...actual,
    adminClientForShop: async (domain: string) => fixtureAdminClient(domain, endpoint),
    toAdminClient: (admin: unknown) => (admin as { __chaos?: unknown })?.__chaos ?? actual.toAdminClient(admin as never),
  };
});

const sent: Array<{ shopId: string; notification: Notification }> = [];
vi.mock("../../app/services/notifications.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../app/services/notifications.server")>()),
  notify: async (shopId: string, notification: Notification) => {
    sent.push({ shopId, notification });
    return { sent: true };
  },
}));

const enqueued: Array<{ name: QueueName; ref: JobRef }> = [];
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

// Eight products outlast Flow's ten seconds, so a start of all of them goes to the worker.
const CATALOG = { catalog: { products: 8, variantsPerProduct: 1 }, percent: -10 } as const;

function useShop(chaos: ChaosContext) {
  endpoint = chaos.server.endpoint();
  pending = { shop: chaos.fixture.domain, properties: {} };
  enqueued.length = 0;
  sent.length = 0;
}

async function flowStart(campaignId: string) {
  pending = { ...pending, properties: { "campaign-id": campaignId } };
  const { action } = await import("../../app/routes/flow.actions.start-campaign");
  const response = (await action({
    request: new Request("https://example.invalid/flow/actions/start-campaign", { method: "POST" }),
    params: {},
    context: {},
  } as never)) as Response;
  return { status: response.status, message: ((await response.json()) as { message: string }).message };
}

/** The job Flow's start queued, run as the worker runs it. */
async function work() {
  expect(enqueued, "the start was not handed to the worker").toHaveLength(1);
  const { handleJob } = await import("../../app/worker/handlers.server");
  const job = enqueued.shift()!;
  return handleJob(job.name, job.ref).then(
    () => null,
    (error: Error) => error,
  );
}

/** The campaign page's Status card, from its own loader. */
async function statusCard(campaignId: string) {
  const { loader } = await import("../../app/routes/app.campaigns.$id");
  const page = (await loader({
    request: new Request(`https://example.invalid/app/campaigns/${campaignId}`),
    params: { id: campaignId },
    context: {},
  } as never)) as { lifecycle: { label: string; tone: string; explanation: string } };
  return page.lifecycle;
}

async function listLabel(shopId: string, campaignId: string) {
  const { campaigns } = await listCampaigns(shopId, filtersFrom(new URLSearchParams("status=all")));
  return campaigns.find((row) => row.id === campaignId)?.lifecycle.label;
}

const emailsAbout = (campaignId: string) =>
  sent.filter(({ notification }) => notification.kind === "run-failed" && notification.campaignId === campaignId);

const scheduleOf = async (campaignId: string) =>
  (await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId }, select: { schedule: true } })).schedule;

describe("chaos: a queued run refused before it starts", () => {
  it("by a blocking guardrail is on the Status card and the list, emailed once, and cleared by the run that follows", async () => {
    await withChaos("queued-refused-guardrail", CATALOG, async (chaos) => {
      const { shopId, campaignId } = chaos.fixture;
      useShop(chaos);
      // A floor above every price, set to block rather than clamp: only planning finds it.
      await writeSettings(shopId, { ...DEFAULT_SETTINGS, minPrice: 100_000 });
      await prisma.campaign.update({ where: { id: campaignId }, data: { guardrailViolationPolicy: "block" } });

      const started = await flowStart(campaignId);
      expect(started.status, started.message).toBe(200);
      expect(started.message).toMatch(/background worker is applying it/);

      const failed = await work();
      expect(failed?.message).toMatch(/^A guardrail stopped this run before anything was written: "/);
      expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status).toBe("DRAFT");
      expect(chaos.fake.writeLog).toHaveLength(0);

      // Said on the campaign, where the merchant looks.
      expect(queuedRefusal(await scheduleOf(campaignId))).toMatchObject({ verb: "apply", reason: expect.stringMatching(/A guardrail stopped this run/) });
      const card = await statusCard(campaignId);
      expect(card.label, "the Status card says nothing of a refused queued apply").toBe("Draft — couldn't apply");
      expect(card.tone).toBe("warning");
      expect(card.explanation).toMatch(/^Its apply was handed to the background worker and could not run: A guardrail stopped this run/);
      expect(await listLabel(shopId, campaignId)).toBe("Draft — couldn't apply");

      // And told once.
      const emails = emailsAbout(campaignId);
      expect(emails, "a refused queued apply emailed nobody").toHaveLength(1);
      expect(emails[0].notification).toMatchObject({ queued: "apply", reasons: [expect.stringMatching(/A guardrail stopped this run/)] });

      // The floor lifted, Flow starts it again: the worker applies it, and the refusal is gone.
      await writeSettings(shopId, DEFAULT_SETTINGS);
      expect((await flowStart(campaignId)).status).toBe(200);
      expect(await work()).toBeNull();
      expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status).toBe("ACTIVE");
      expect(queuedRefusal(await scheduleOf(campaignId)), "a refusal outlived the run that followed it").toBeNull();
      expect((await statusCard(campaignId)).label).toBe("Active");
      expect(emailsAbout(campaignId)).toHaveLength(1);
      await chaos.expectHonest(await chaos.latestRunId("APPLY"));
    });
  });

  it("because its segment went while it waited is said and emailed; one already gone is refused to Flow itself", async () => {
    await withChaos("queued-refused-segment", CATALOG, async (chaos) => {
      const { shopId, campaignId, variantGids } = chaos.fixture;
      useShop(chaos);
      const segment = await createSegment(shopId, { name: "Goes while queued", kind: "FROZEN", variantGids });
      // The segment in its column, where the run reads it (#1141), and the relation beside it.
      await redefine(campaignId, { segmentId: segment.id });
      await prisma.campaign.update({ where: { id: campaignId }, data: { segments: { connect: { id: segment.id } } } });

      // Queued, then the segment goes before the worker gets to it.
      expect((await flowStart(campaignId)).status).toBe(200);
      await prisma.segment.delete({ where: { id: segment.id } });
      const failed = await work();
      expect(failed?.message).toMatch(/segment was deleted/);
      expect(queuedRefusal(await scheduleOf(campaignId))?.reason).toMatch(/segment was deleted/);
      expect((await statusCard(campaignId)).label).toBe("Draft — couldn't apply");
      expect(emailsAbout(campaignId)).toHaveLength(1);

      // Now that it is gone, Flow's next start is refused before anything is queued, and
      // Flow's run log is where that is said.
      sent.length = 0;
      const refused = await flowStart(campaignId);
      expect(refused.status, refused.message).toBeGreaterThanOrEqual(400);
      expect(refused.message).toMatch(/segment was deleted/);
      expect(enqueued, "a start Flow could have been told about was queued").toEqual([]);
      expect(chaos.fake.writeLog).toHaveLength(0);
    });
  });

  it("by a gate that answers rather than throws -- an approval required while it waited -- is said and emailed too", async () => {
    await withChaos("queued-refused-approval", CATALOG, async (chaos) => {
      const { shopId, campaignId } = chaos.fixture;
      useShop(chaos);
      expect((await flowStart(campaignId)).status).toBe(200);

      // The store starts asking for a second person's sign-off on anything over one variant.
      await writeSettings(shopId, { ...DEFAULT_SETTINGS, approvalThreshold: 1 });
      expect(await work(), "a refusal is an answer, not a failed job").toBeNull();
      expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status).toBe("DRAFT");
      expect(queuedRefusal(await scheduleOf(campaignId))?.reason).toMatch(/need a second person's approval/);
      expect((await statusCard(campaignId)).label).toBe("Draft — couldn't apply");
      expect(emailsAbout(campaignId)).toHaveLength(1);
      expect(chaos.fake.writeLog).toHaveLength(0);
    });
  });
});
