/**
 * A scheduled or Flow-started campaign gets the typed confirmation too (#1009).
 *
 * The confirmation for a campaign over the store's thresholds -- more prices than the
 * variant threshold, or a change deeper than the change threshold (#818) -- was asked only by
 * the Apply button. The scheduler and the Flow action start campaigns with nobody there, so a
 * scheduled 95%-off sale was never confirmed: not when it was saved with dates, and not when
 * it started. And duplicating a campaign stored with a reduction of 100% or more made a copy
 * that every Apply would refuse.
 *
 * Driven through the real paths: the editor's create action, the campaign page's action
 * (new dates, "Scheduled and Flow starts", Duplicate), the campaigns list's action, the real
 * `tick`, and Flow's Start action. Replaced: `authenticate` (no signed requests),
 * `adminClientForShop` (the fixture shop has no Shopify session), `notify` (a recorder), and
 * the web queue (a recorder, asserted empty: nothing here is large enough to leave a request).
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { startRefusal } from "../../app/lib/scheduling/start-refusal";
import type { Notification } from "../../app/lib/notifications/templates";
import { tick } from "../../app/services/scheduler.server";
import { createSegment } from "../../app/services/segments-crud.server";
import type { JobRef, QueueName } from "../../app/worker/queues";
import { chaosAdminClient, chaosAdminContext } from "../harness/http-client";
import { type ChaosContext, fixtureAdminClient, withChaos } from "../harness/scenario";

/** A staff member's id, as App Bridge's session token carries it: "Staff 7946" on screen. */
const STAFF = "91614707946";
let pending: { shop: string; properties: Record<string, string> } = { shop: "", properties: {} };
let endpoint = "";

vi.mock("../../app/shopify.server", () => ({
  authenticate: {
    admin: async () => ({ session: { shop: pending.shop }, sessionToken: { sub: STAFF }, admin: chaosAdminContext(endpoint) }),
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
    // The fake for this scenario's own shop only, so a tick leaves every other shop alone (#881).
    adminClientForShop: async (domain: string) => fixtureAdminClient(domain, endpoint),
    // Flow's `admin` is the chaos client already; the page's is an admin context the fake answers.
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

const HOUR = 60 * 60_000;
const day = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString().slice(0, 10);
const CATALOG = { catalog: { products: 8, variantsPerProduct: 1 }, percent: -10 } as const;

function formOf(fields: Record<string, string>): FormData {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return body;
}

function useShop(chaos: ChaosContext) {
  endpoint = chaos.server.endpoint();
  pending = { shop: chaos.fixture.domain, properties: {} };
  enqueued.length = 0;
  sent.length = 0;
}

type Confirm = { confirm: { unconfirmed: string; radius: { largest: { title: string; before: string; after: string } | null } } };

/**
 * The editor's Create, as its form posts it: 95% off, from two days out to three, over a
 * saved segment when one is given. A redirect means it was created.
 */
async function create(name: string, fields: Record<string, string> = {}): Promise<{ id: string } | Confirm> {
  const { action } = await import("../../app/routes/app.campaigns.new");
  const answer = await action({
    request: new Request("https://example.invalid/app/campaigns/new", {
      method: "POST",
      body: formOf({
        name,
        ruleKind: "percent-change",
        ruleValue: "95",
        ruleDirection: "down",
        startDate: day(48 * HOUR),
        endDate: day(72 * HOUR),
        ...fields,
      }),
    }),
    params: {},
    context: {},
  } as never);
  if (answer instanceof Response) return { id: answer.headers.get("Location")!.split("/").pop()! };
  return answer as Confirm;
}

/** The campaign page's action, as its buttons post to it. */
async function press(campaignId: string, fields: Record<string, string>) {
  const { action } = await import("../../app/routes/app.campaigns.$id");
  const answer = await action({
    request: new Request(`https://example.invalid/app/campaigns/${campaignId}`, { method: "POST", body: formOf(fields) }),
    params: { id: campaignId },
    context: {},
  } as never);
  return (answer instanceof Response ? { ok: true, message: "", location: answer.headers.get("Location") } : answer) as {
    ok: boolean;
    message: string;
    location?: string | null;
  };
}

/** The campaign page's loader: its Status card and "Scheduled and Flow starts". */
async function page(campaignId: string) {
  const { loader } = await import("../../app/routes/app.campaigns.$id");
  return (await loader({
    request: new Request(`https://example.invalid/app/campaigns/${campaignId}`),
    params: { id: campaignId },
    context: {},
  } as never)) as {
    lifecycle: { label: string; explanation: string };
    startConfirmation: { confirmed: { by: string; reach: string } | null; unconfirmed: string | null };
  };
}

/** Flow's Start a price campaign, for this campaign. */
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

/** Its start moved to a minute ago, keeping everything else in its schedule: the next tick is due. */
async function makeDue(campaignId: string) {
  const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
  const startAt = new Date(Date.now() - 60_000);
  await prisma.campaign.update({
    where: { id: campaignId },
    data: { startAt, schedule: { ...(campaign.schedule as object), startAt: startAt.toISOString() } as never },
  });
}

const campaignOf = (id: string) => prisma.campaign.findUniqueOrThrow({ where: { id } });
const confirmationOf = async (id: string) =>
  ((await campaignOf(id)).schedule as Record<string, unknown>).startConfirmed as Record<string, unknown> | undefined;
const applyRuns = (campaignId: string) => prisma.campaignRun.count({ where: { campaignId, kind: "APPLY" } });
const historyCount = (campaignId: string) =>
  prisma.auditLogEntry.count({ where: { entityId: campaignId, action: "campaign.transition" } });
const emailsAbout = (campaignId: string) =>
  sent.filter(({ notification }) => "campaignId" in notification && notification.campaignId === campaignId);

function prices(chaos: ChaosContext) {
  const { variantGids, baseline } = chaos.fixture;
  const full = (gid: string) => (baseline.get(gid)! / 100).toFixed(2);
  const sale = (gid: string) => (Math.round(baseline.get(gid)! * 0.05) / 100).toFixed(2);
  return {
    untouched: (gids = variantGids) => gids.every((gid) => chaos.fake.priceOf(gid) === full(gid)),
    onSale: (gids = variantGids) => gids.every((gid) => chaos.fake.priceOf(gid) === sale(gid)),
  };
}

describe("chaos: the typed confirmation for a scheduled start (#1009)", () => {
  it("asks for the word when a dated campaign trips the check, keeps it, and the scheduler starts it", async () => {
    await withChaos("start-confirm-create", CATALOG, async (chaos) => {
      const { shopId, variantGids } = chaos.fixture;
      useShop(chaos);
      const { untouched, onSale } = prices(chaos);

      // 95% off eight variants, with dates: asked, in the start check's sentence, and nothing
      // is created -- not without the word, and not with a near miss.
      for (const confirmation of [undefined, "", "appl"]) {
        const asked = await create("Deep sale", confirmation === undefined ? {} : { confirmation });
        expect("confirm" in asked, `a dated 95% sale was created with ${JSON.stringify(confirmation)} typed`).toBe(true);
        const { unconfirmed, radius } = (asked as Confirm).confirm;
        expect(unconfirmed).toContain("8 prices move more than 50% from their baseline");
        expect(unconfirmed).toMatch(/the largest is “gid:\/\/shopify\/ProductVariant\/[^”]+”, down 95%/);
        expect(unconfirmed).toContain("Nobody has confirmed it by typing “apply”.");
        expect(unconfirmed, "the stored sentence carries a price").not.toContain("$");
        // The box shows the largest change's prices beside the sentence.
        expect(radius.largest?.before).toMatch(/^\$\d+\.00$/);
        expect(await prisma.campaign.count({ where: { shopId, name: "Deep sale" } })).toBe(0);
      }

      // The word, as a merchant might type it: created, scheduled, with who confirmed it and
      // what it reached, in the campaign and in the log of its creation.
      const created = await create("Deep sale", { confirmation: " Apply " });
      expect("id" in created, JSON.stringify(created)).toBe(true);
      const id = (created as { id: string }).id;
      const campaign = await campaignOf(id);
      expect(campaign.status).toBe("SCHEDULED");
      const confirmed = await confirmationOf(id);
      expect(confirmed).toMatchObject({ by: `staff:${STAFF}`, planned: 8, largeChanges: 8, largestBasisPoints: 9_500, atMinimum: 0 });
      expect(Date.now() - Date.parse(String(confirmed!.at))).toBeLessThan(60_000);
      const log = await prisma.auditLogEntry.findFirstOrThrow({ where: { shopId, entityId: id, action: "campaign.created" } });
      expect(log.after).toMatchObject({ status: "SCHEDULED", startConfirmed: confirmed });
      // Its page says who confirmed it, and nothing needs confirming.
      const confirmedPage = await page(id);
      expect(confirmedPage.lifecycle.label).toBe("Scheduled");
      expect(confirmedPage.startConfirmation).toEqual({
        confirmed: expect.objectContaining({ by: "Staff 7946", reach: "8 prices; 8 past the change threshold, the largest 95%" }),
        unconfirmed: null,
      });

      // Asked exactly when it trips: a dated 10% sale, and an undated 95% one -- whose Apply
      // asks on its page -- are created without the word and without a confirmation.
      const shallow = await create("Shallow sale", { ruleValue: "10" });
      const undated = await create("Undated sale", { startDate: "", endDate: "" });
      for (const other of [shallow, undated]) {
        expect("id" in other, JSON.stringify(other)).toBe(true);
        expect(await confirmationOf((other as { id: string }).id)).toBeUndefined();
      }

      // The scheduler starts the confirmed sale when it comes due: nothing asks, and every
      // price is written at 95% off.
      expect(untouched()).toBe(true);
      await makeDue(id);
      const result = await tick(new Date());
      expect(result.failures.filter((failure) => failure.campaignId === id)).toEqual([]);
      expect((await campaignOf(id)).status, "a confirmed scheduled start was refused").toBe("ACTIVE");
      expect(onSale(variantGids)).toBe(true);
      expect(emailsAbout(id).filter(({ notification }) => "notStarted" in notification)).toEqual([]);
      expect(enqueued).toEqual([]);
    });
  });

  it("refuses a start that grew past its confirmation, once, by the schedule and by Flow, until new dates confirm it", async () => {
    await withChaos("start-confirm-widened", CATALOG, async (chaos) => {
      const { shopId, variantGids } = chaos.fixture;
      useShop(chaos);
      const { untouched, onSale } = prices(chaos);

      // Confirmed over a segment of four variants, then the segment is widened to all eight:
      // the scope the merchant confirmed is not the scope that would start.
      const segment = await createSegment(shopId, { name: "Four", kind: "FROZEN", variantGids: variantGids.slice(0, 4) });
      const created = await create("Segment sale", { segment: segment.id, confirmation: "apply" });
      const id = (created as { id: string }).id;
      expect(await confirmationOf(id)).toMatchObject({ planned: 4, largeChanges: 4, largestBasisPoints: 9_500 });
      await prisma.segment.update({ where: { id: segment.id }, data: { frozenVariantGids: variantGids } });

      // Before its start, its page already says so, and where to confirm it.
      const before = await page(id);
      expect(before.lifecycle.label).toBe("Scheduled — needs confirming");
      expect(before.startConfirmation.unconfirmed).toMatch(/^It reaches further than Staff 7946 confirmed: it now writes 8 prices/);
      await makeDue(id);

      // The scheduler: refused for good (#975), not failed. Said once on the campaign and
      // once by email, naming what grew and what to do; nothing written, no run row.
      const first = await tick(new Date());
      expect(first.failures.filter((failure) => failure.campaignId === id), "a refusal reported as our failure").toEqual([]);
      const after = await campaignOf(id);
      expect(after.status).toBe("SCHEDULED");
      const reason = startRefusal(after.schedule);
      expect(reason, "the start was not recorded as refused").not.toBeNull();
      expect(reason).toContain("It reaches further than Staff 7946 confirmed: it now writes 8 prices, and 4 were confirmed");
      expect(reason).toContain("8 prices now move more than 50% from their baseline or land that far below cost, and 4 did");
      expect(reason).toContain("move its dates and type it when asked, or apply it by hand");
      expect(untouched()).toBe(true);
      expect(await applyRuns(id)).toBe(0);
      const emails = emailsAbout(id);
      expect(emails).toHaveLength(1);
      expect(emails[0].notification).toMatchObject({ kind: "run-failed", notStarted: true });
      expect((emails[0].notification as { reasons: string[] }).reasons[0]).toContain("It reaches further than");

      // Later ticks leave it alone: no claim, no history, no second email.
      const history = await historyCount(id);
      await tick(new Date());
      await tick(new Date());
      expect(await historyCount(id), "a later tick claimed the refused start again").toBe(history);
      expect(emailsAbout(id)).toHaveLength(1);

      // Flow is refused too, with a 4xx it shows and does not resend, saying what to do.
      const flow = await flowStart(id);
      expect(flow.status, flow.message).toBe(400);
      expect(flow.message).toMatch(/^"Segment sale" was not applied: It reaches further than Staff 7946 confirmed/);
      expect(flow.message).toContain("Shopify Flow cannot type “apply”");
      expect(untouched()).toBe(true);
      expect((await campaignOf(id)).status).toBe("SCHEDULED");

      // New dates are a save of its start: asked again, refused without the word, and the
      // dates stay where they were.
      const dates = { intent: "reschedule", startDate: day(24 * HOUR), startTime: "09:00", endDate: day(96 * HOUR), endTime: "09:00" };
      const unasked = await press(id, dates);
      expect(unasked.ok).toBe(false);
      expect(unasked.message).toMatch(/^It reaches further than Staff 7946 confirmed: .*Type “apply” in the box .*The dates were not changed\.$/);
      expect((await campaignOf(id)).startAt!.getTime()).toBeLessThan(Date.now());

      // With it: the new start is confirmed as the campaign is now, and runs when due.
      const moved = await press(id, { ...dates, confirmation: "apply" });
      expect(moved.ok, moved.message).toBe(true);
      expect(await confirmationOf(id)).toMatchObject({ by: `staff:${STAFF}`, planned: 8, largeChanges: 8 });
      await makeDue(id);
      await tick(new Date());
      expect((await campaignOf(id)).status, "the confirmed new start did not run").toBe("ACTIVE");
      expect(onSale()).toBe(true);
      expect(enqueued).toEqual([]);
    });
  });

  it("refuses Flow's start of a campaign nobody confirmed, until it is confirmed on its page", async () => {
    await withChaos("start-confirm-flow", { ...CATALOG, percent: -95 }, async (chaos) => {
      const { shopId, campaignId } = chaos.fixture;
      useShop(chaos);
      const { untouched, onSale } = prices(chaos);

      // A draft: no dates, so nothing has asked. Flow cannot type the word: refused, 4xx.
      const refused = await flowStart(campaignId);
      expect(refused.status, refused.message).toBe(400);
      expect(refused.message).toContain("8 prices move more than 50% from their baseline");
      expect(refused.message).toContain("Nobody has confirmed it by typing “apply”.");
      expect(refused.message).toContain("Confirm the campaign as it is now under “Scheduled and Flow starts”");
      expect(untouched()).toBe(true);
      expect((await campaignOf(campaignId)).status).toBe("DRAFT");
      expect(await applyRuns(campaignId)).toBe(0);

      // "Scheduled and Flow starts" on its page asks for the word, then records it.
      const unasked = await press(campaignId, { intent: "confirm-start", confirmation: "" });
      expect(unasked.ok).toBe(false);
      expect(unasked.message).toMatch(/Type “apply” in the box to confirm it as it is now\. Nothing was changed\.$/);
      expect(await confirmationOf(campaignId)).toBeUndefined();

      const confirmed = await press(campaignId, { intent: "confirm-start", confirmation: "apply" });
      expect(confirmed.ok, confirmed.message).toBe(true);
      expect(confirmed.message).toContain("8 prices; 8 past the change threshold, the largest 95%");
      expect(await confirmationOf(campaignId)).toMatchObject({ by: `staff:${STAFF}`, planned: 8, largestBasisPoints: 9_500 });
      const log = await prisma.auditLogEntry.findFirstOrThrow({ where: { entityId: campaignId, action: "campaign.start-confirmed" } });
      expect(log.actor).toBe(`staff:${STAFF}`);

      // Now Flow starts it. Eight products outlast Flow's ten seconds, so the worker runs it,
      // checking again on its own plan: every price at 95% off, read back.
      const started = await flowStart(campaignId);
      expect(started.status, started.message).toBe(200);
      expect(started.message).toMatch(/background worker is applying it/);
      expect(enqueued).toEqual([{ name: "execution", ref: { shopId, campaignId, revert: false, claimedFrom: "DRAFT", actor: "shopify-flow" } }]);
      const { handleJob } = await import("../../app/worker/handlers.server");
      await handleJob(enqueued[0].name, enqueued[0].ref);
      expect((await campaignOf(campaignId)).status).toBe("ACTIVE");
      expect(onSale()).toBe(true);
      await chaos.expectHonest(await chaos.latestRunId("APPLY"));
    });
  });
});

describe("chaos: duplicating a campaign (#1009)", () => {
  it("refuses a copy of a rule every Apply refuses, naming it, from the page and from the list", async () => {
    await withChaos("start-confirm-duplicate", CATALOG, async (chaos) => {
      const { shopId, campaignId } = chaos.fixture;
      useShop(chaos);
      const before = await prisma.campaign.count({ where: { shopId } });

      await prisma.campaign.update({
        where: { id: campaignId },
        data: { ruleRows: [{ segmentIds: [], rule: { kind: "percent-change", percent: -150 } }] },
      });
      const said = /^This campaign reduces prices by 150%, which would make every price free or negative, so a copy of it could never be applied, and none was made\. Create a new campaign with a reduction under 100% instead\.$/;

      const fromPage = await press(campaignId, { intent: "duplicate" });
      expect(fromPage.ok, "the page made a copy of Reduce by 150%").toBe(false);
      expect(fromPage.message).toMatch(said);

      const { action: list } = await import("../../app/routes/app.campaigns._index");
      const fromList = (await list({
        request: new Request("https://example.invalid/app/campaigns", {
          method: "POST",
          body: formOf({ intent: "duplicate", campaignId }),
        }),
        params: {},
        context: {},
      } as never)) as { ok: boolean; message: string } | Response;
      expect(fromList instanceof Response, "the list made a copy of Reduce by 150%").toBe(false);
      expect((fromList as { message: string }).message).toMatch(said);
      expect(await prisma.campaign.count({ where: { shopId } }), "a copy was made").toBe(before);

      // An ordinary rule is copied as before -- without its source's confirmation, which was
      // a person's decision about the source.
      await prisma.campaign.update({
        where: { id: campaignId },
        data: {
          ruleRows: [{ segmentIds: [], rule: { kind: "percent-change", percent: -95 } }],
          schedule: {
            ...((await campaignOf(campaignId)).schedule as object),
            startConfirmed: { by: `staff:${STAFF}`, at: new Date().toISOString(), planned: 8, largeChanges: 8, largestBasisPoints: 9_500, atMinimum: 0 },
          } as never,
        },
      });
      const copied = await press(campaignId, { intent: "duplicate" });
      expect(copied.location, copied.message).toMatch(/^\/app\/campaigns\/.+\?duplicated=1$/);
      const copyId = copied.location!.split("/").pop()!.split("?")[0];
      const copy = (await campaignOf(copyId)).schedule as Record<string, unknown>;
      expect(copy.ast, "the copy lost its scope").toEqual(((await campaignOf(campaignId)).schedule as Record<string, unknown>).ast);
      expect(copy.startConfirmed, "the copy carried its source's confirmation").toBeUndefined();
      expect(await confirmationOf(campaignId), "the source lost its confirmation").toBeDefined();
    });
  });
});
