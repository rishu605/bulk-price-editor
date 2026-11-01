/**
 * A campaign's own floors and floor-breach policy (#816, PRD A-3.7, D30).
 *
 * The model stored a campaign's `guardrails` and the resolver merged them, tighter only, but no
 * screen or import ever set one: every campaign was created with `{}`, and its policy was copied
 * from Settings without the merchant seeing it. A clearance with a lower floor than every day, or
 * a luxury line with a higher one, could not be said.
 *
 * Driven through the real paths: the editor's create action, the campaign page's action (its
 * Floors card, Duplicate) and loader, the real preview and the real run. Replaced:
 * `authenticate` (no signed requests), `adminClientForShop` and `toAdminClient` (the fixture
 * shop has no Shopify session), `notify` (a recorder), and the web queue (a recorder: nothing
 * here is large enough to plan in the background).
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import type { AppError } from "../../app/lib/errors/app-error";
import { breachPolicyOf, keepingOtherPolicies } from "../../app/services/campaigns/model.server";
import { previewCampaign } from "../../app/services/campaigns/preview.server";
import { runCampaign } from "../../app/services/campaigns/run.server";
import { DEFAULT_SETTINGS, writeSettings } from "../../app/services/settings.server";
import type { JobRef, QueueName } from "../../app/worker/queues";
import { chaosAdminClient, chaosAdminContext } from "../harness/http-client";
import { type ChaosContext, fixtureAdminClient, withChaos } from "../harness/scenario";

/** A staff member's id, as App Bridge's session token carries it. */
const STAFF = "91614707946";
let shop = "";
let endpoint = "";

vi.mock("../../app/shopify.server", () => ({
  authenticate: {
    admin: async () => ({ session: { shop }, sessionToken: { sub: STAFF }, admin: chaosAdminContext(endpoint) }),
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

vi.mock("../../app/services/notifications.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../app/services/notifications.server")>()),
  notify: async () => ({ sent: true }),
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

/** Three variants, 20% off. */
const CATALOG = { catalog: { products: 3, variantsPerProduct: 1 }, percent: -20 } as const;

function formOf(fields: Record<string, string>): FormData {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return body;
}

async function useShop(chaos: ChaosContext) {
  endpoint = chaos.server.endpoint();
  shop = chaos.fixture.domain;
  enqueued.length = 0;
  // Every baseline at $100, so 20% off is $80: a $95 floor sits between the sale price and the
  // normal one, and a $50 floor below both.
  await prisma.baseline.updateMany({ where: { shopId: chaos.fixture.shopId, supersededAt: null }, data: { basePrice: 10_000n } });
}

/**
 * The floor fields as the editor and the Floors card post them: the store's own values, with
 * `over` typed in. A store with only a minimum price shows that, an unticked box and no margin.
 */
function floorFields(store: { minPrice: string }, over: Record<string, string> = {}) {
  return { floors: "1", floorMinMargin: "", floorMinPrice: store.minPrice, breachPolicy: "", ...over };
}

/** The editor's Create, as its form posts it: 20% off the fixture's products. A redirect means it was created. */
async function create(name: string, fields: Record<string, string>): Promise<{ id: string } | { loosen: string }> {
  const { action } = await import("../../app/routes/app.campaigns.new");
  const answer = await action({
    request: new Request("https://example.invalid/app/campaigns/new", {
      method: "POST",
      body: formOf({ name, ruleKind: "percent-change", ruleValue: "20", ruleDirection: "down", tag: "chaos", ...fields }),
    }),
    params: {},
    context: {},
  } as never);
  if (answer instanceof Response) return { id: answer.headers.get("Location")!.split("/").pop()! };
  return answer as { loosen: string };
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
    loosen?: string;
    location?: string | null;
  };
}

/** The campaign page's loader: its Floors card. */
async function page(campaignId: string) {
  const { loader } = await import("../../app/routes/app.campaigns.$id");
  return (await loader({
    request: new Request(`https://example.invalid/app/campaigns/${campaignId}`),
    params: { id: campaignId },
    context: {},
  } as never)) as { floors: { applied: string; whose: string; unconfirmed: string | null } };
}

const campaignOf = (id: string) => prisma.campaign.findUniqueOrThrow({ where: { id } });
const preview = (shopId: string, id: string) => previewCampaign(shopId, id, { limit: 100 });
const loosenings = (campaignId: string) =>
  prisma.auditLogEntry.findMany({ where: { entityId: campaignId, action: "campaign.floors.loosened" }, orderBy: { createdAt: "asc" } });
/** Applies a campaign as the campaign page does, through the real run path. */
const applyOf = (chaos: ChaosContext, campaignId: string) =>
  runCampaign(chaos.fixture.shopId, campaignId, chaosAdminClient(endpoint), { actor: `staff:${STAFF}`, verifySampleRate: 1 });

describe("chaos: a campaign's own floors and policy (#816)", () => {
  it("a floor of its own tighter than the store's skips, blocks or clamps as the campaign chose", async () => {
    await withChaos("campaign-floors-tighter", CATALOG, async (chaos) => {
      const { shopId, campaignId } = chaos.fixture;
      await useShop(chaos);
      // The store: a $50 minimum, which 20% off $100 never reaches, under Clamp.
      await writeSettings(shopId, { ...DEFAULT_SETTINGS, minPrice: 50 });
      const store = { minPrice: "50.00" };
      expect((await preview(shopId, campaignId)).counts.clamped, "the store's floor already bit").toBe(0);

      // Its own $95, and Skip: every variant is left alone, though Settings says Clamp.
      expect((await press(campaignId, { intent: "floors", ...floorFields(store, { floorMinPrice: "95.00", breachPolicy: "skip" }) })).ok).toBe(true);
      expect((await campaignOf(campaignId)).guardrails).toEqual({ minPrice: { amount: 9_500, currency: "USD" }, violationPolicy: "skip" });
      expect(await breachPolicyOf(shopId, await campaignOf(campaignId))).toEqual({ policy: "skip", kept: false, store: "clamp", own: true });
      const skipped = await preview(shopId, campaignId);
      expect(skipped.counts).toMatchObject({ planned: 0, skipped: 3, clamped: 0 });

      // Block: the preview is stopped, saying the campaign chose it, and so is Apply.
      await press(campaignId, { intent: "floors", ...floorFields(store, { floorMinPrice: "95.00", breachPolicy: "block" }) });
      const blocked = await preview(shopId, campaignId);
      expect(blocked.blocked?.message).toContain("under its $95.00 floor");
      expect(blocked.blocked?.message).toContain(
        'This campaign chose "Block the whole campaign" itself, whatever Settings says. Lower the floor in Settings or in this campaign\'s own floors,',
      );
      const pressed = await chaos.apply().then(
        () => null,
        (error: unknown) => error as AppError,
      );
      expect(pressed?.code, "its own Block did not stop the run").toBe("GUARDRAIL_BLOCKED");
      expect(chaos.fake.writeLog, "a blocked run wrote").toHaveLength(0);
      expect((await campaignOf(campaignId)).status).toBe("DRAFT");
      // Settings names it beside its field, as one the saved policy does not reach.
      expect(await keepingOtherPolicies(shopId, "clamp")).toEqual({
        campaigns: [{ id: campaignId, name: (await campaignOf(campaignId)).name, policy: "block", own: true }],
        total: 1,
      });

      // Clamp: written at its own floor, not the store's, and the floors and policy say whose.
      await press(campaignId, { intent: "floors", ...floorFields(store, { floorMinPrice: "95.00", breachPolicy: "clamp" }) });
      const shown = (await page(campaignId)).floors;
      expect(shown.applied).toBe("At least $95.00");
      expect(shown.whose).toBe("This campaign's own minimum price $95.00 (the store's is $50.00), tighter than the store's. The rest are the store's, from Settings.");
      const applied = await chaos.apply();
      expect(applied.clean).toBe(true);
      await chaos.expectHonest(await chaos.latestRunId("APPLY"));
      expect([...chaos.livePrices().values()]).toEqual(["95.00", "95.00", "95.00"]);
      // Started, it keeps its own choice as the one it started with, whatever Settings says next.
      expect((await campaignOf(campaignId)).guardrailViolationPolicy).toBe("clamp");
      await writeSettings(shopId, { ...DEFAULT_SETTINGS, minPrice: 50, violationPolicy: "block" });
      expect(await breachPolicyOf(shopId, await campaignOf(campaignId))).toEqual({ policy: "clamp", kept: true, store: "block", own: true });
      // Each save is in the log, with who and what; none of them went below the store's.
      expect(await prisma.auditLogEntry.count({ where: { entityId: campaignId, action: "campaign.floors.update" } })).toBe(3);
      expect(await loosenings(campaignId)).toHaveLength(0);
    });
  });

  it("going below the store's floor is refused without the word, and logged with it, before and after it starts", async () => {
    await withChaos("campaign-floors-loosen", CATALOG, async (chaos) => {
      const { shopId, campaignId } = chaos.fixture;
      await useShop(chaos);
      // The store: a $95 minimum under Clamp, so 20% off $100 is written at $95.
      await writeSettings(shopId, { ...DEFAULT_SETTINGS, minPrice: 95 });
      const store = { minPrice: "95.00" };
      expect((await preview(shopId, campaignId)).counts.clamped).toBe(3);

      // A clearance floor of $50, without the word, or with the wrong one: asked, and nothing saved.
      for (const loosen of [undefined, "", "apply"]) {
        const asked = await press(campaignId, { intent: "floors", ...floorFields(store, { floorMinPrice: "50.00", ...(loosen === undefined ? {} : { loosen }) }) });
        expect(asked.ok, `loosened with ${JSON.stringify(loosen)} typed`).toBe(false);
        expect(asked.loosen).toContain("This goes below the store's floors: minimum price $50.00 (the store's is $95.00).");
        expect(asked.loosen).toContain("Type loosen to confirm it.");
      }
      expect((await campaignOf(campaignId)).guardrails).toEqual({});
      expect(await loosenings(campaignId)).toHaveLength(0);
      expect((await preview(shopId, campaignId)).counts.clamped, "an unconfirmed floor was applied").toBe(3);
      // A value that is no floor is refused in the page's banner, naming the field.
      expect(await press(campaignId, { intent: "floors", ...floorFields(store, { floorMinMargin: "150" }) })).toEqual({
        ok: false,
        message: "This campaign's minimum margin (%) must be a number from 0 to 99.9, or blank for none. “150” is not. Nothing was changed.",
      });

      // With it: saved, and logged with who typed it, what the floor went below, and the word.
      expect((await press(campaignId, { intent: "floors", ...floorFields(store, { floorMinPrice: "50.00", loosen: " Loosen " }) })).ok).toBe(true);
      const stored = (await campaignOf(campaignId)).guardrails as { minPrice: unknown; loosened: { floors: string[]; by: string } };
      expect(stored.minPrice).toEqual({ amount: 5_000, currency: "USD" });
      expect(stored.loosened).toMatchObject({ floors: ["minPrice"], by: `staff:${STAFF}` });
      const [first] = await loosenings(campaignId);
      expect(first).toMatchObject({
        actor: `staff:${STAFF}`,
        before: { minPrice: { minor: "9500", currency: "USD" } },
        after: { minPrice: { minor: "5000", currency: "USD" }, confirmation: "Loosen" },
      });
      expect((await page(campaignId)).floors.whose).toContain("below the store's, confirmed by Staff 7946 on");

      // Its preview and its run price at $80 now: its own floor, below the store's.
      expect((await preview(shopId, campaignId)).counts).toMatchObject({ planned: 3, clamped: 0 });
      expect((await chaos.apply()).clean).toBe(true);
      expect([...chaos.livePrices().values()]).toEqual(["80.00", "80.00", "80.00"]);

      // Started: taking it further down asks again; changing something else does not.
      expect((await press(campaignId, { intent: "floors", ...floorFields(store, { floorMinPrice: "10.00" }) })).ok).toBe(false);
      expect((await press(campaignId, { intent: "floors", ...floorFields(store, { floorMinPrice: "50.00", floorMinMargin: "5" }) })).ok).toBe(true);
      expect(await loosenings(campaignId)).toHaveLength(1);
      expect((await press(campaignId, { intent: "floors", ...floorFields(store, { floorMinPrice: "10.00", floorMinMargin: "5", loosen: "loosen" }) })).ok).toBe(
        true,
      );
      expect(await loosenings(campaignId)).toHaveLength(2);
      // A margin floor of its own, with no cost recorded, leaves the variants alone, as the store's does.
      expect((await preview(shopId, campaignId)).rows.map((row) => row.reason)).toEqual(["missing-cost", "missing-cost", "missing-cost"]);
      // Its policy is not offered once it has started (D21): a post naming one changes nothing.
      // The margin taken off again, which is none of the store's either, so no word.
      expect((await press(campaignId, { intent: "floors", ...floorFields(store, { floorMinPrice: "10.00", breachPolicy: "block" }) })).ok).toBe(true);
      expect((await breachPolicyOf(shopId, await campaignOf(campaignId))).policy).toBe("clamp");
      expect(await loosenings(campaignId)).toHaveLength(2);

      // A copy keeps the floors and not the confirmation: the store's applies to it until somebody
      // types the word for the copy, and its page says so.
      const copied = await press(campaignId, { intent: "duplicate" });
      const copyId = copied.location!.split("/").pop()!.split("?")[0];
      expect((await campaignOf(copyId)).guardrails).toEqual({ minPrice: { amount: 1_000, currency: "USD" } });
      expect((await page(copyId)).floors.unconfirmed).toContain("This campaign's own minimum price $10.00 (the store's is $95.00) is below the store's");
      expect((await preview(shopId, copyId)).counts.clamped).toBe(3);

      // The editor's preview prices the draft with its floor, and says Create will ask.
      const { action: previewAction } = await import("../../app/routes/app.preview-draft");
      const draft = (await previewAction({
        request: new Request("https://example.invalid/app/preview-draft", {
          method: "POST",
          body: formOf({ ruleKind: "percent-change", ruleValue: "20", ruleDirection: "down", tag: "chaos", ...floorFields(store, { floorMinPrice: "50.00", breachPolicy: "skip" }) }),
        }),
        params: {},
        context: {},
      } as never)) as { rows: Array<{ after: string | null }>; floors: { applied: string; whose: string; below: string | null; policy: string } };
      expect(draft.floors).toEqual({
        applied: "At least $50.00",
        whose: "The rest are the store's, from Settings.",
        below: "Below the store's: minimum price $50.00 (the store's is $95.00). Create asks you to type loosen to confirm it.",
        policy: "Skip that variant, price the rest: this campaign's own choice. Settings says “Clamp it to the floor and carry on”, which it does not follow",
      });

      // The editor asks the same: nothing is created without the word, and with it the log says who.
      const refused = await create("Clearance", floorFields(store, { floorMinPrice: "50.00" }));
      expect("loosen" in refused && refused.loosen).toContain("minimum price $50.00 (the store's is $95.00)");
      expect(await prisma.campaign.count({ where: { shopId, name: "Clearance" } })).toBe(0);
      const made = await create("Clearance", floorFields(store, { floorMinPrice: "50.00", loosen: "loosen" }));
      expect("id" in made, JSON.stringify(made)).toBe(true);
      const clearance = (made as { id: string }).id;
      expect(await loosenings(clearance)).toEqual([expect.objectContaining({ actor: `staff:${STAFF}`, after: expect.objectContaining({ confirmation: "loosen" }) })]);
      const created = await prisma.auditLogEntry.findFirstOrThrow({ where: { entityId: clearance, action: "campaign.created" } });
      expect(created.after).toMatchObject({ minPrice: { minor: "5000", currency: "USD" } });
    });
  });

  it("a campaign whose floor fields nobody touched sets nothing, and follows the store as D21 says", async () => {
    await withChaos("campaign-floors-untouched", CATALOG, async (chaos) => {
      const { shopId } = chaos.fixture;
      await useShop(chaos);
      await writeSettings(shopId, { ...DEFAULT_SETTINGS, minPrice: 95 });

      // The editor's fields as rendered, the store's values in them: nothing of its own.
      const made = await create("Untouched", floorFields({ minPrice: "95.00" }));
      expect("id" in made, JSON.stringify(made)).toBe(true);
      const id = (made as { id: string }).id;
      expect((await campaignOf(id)).guardrails).toEqual({});
      expect((await campaignOf(id)).guardrailViolationPolicy).toBe("clamp");
      expect((await page(id)).floors).toEqual({ applied: "At least $95.00", whose: "The store's floors, from Settings.", unconfirmed: null, fields: expect.anything(), store: "At least $95.00", currency: "USD" });

      // Not started, it follows the store's policy: Block saved, and its preview blocks, told to
      // change Settings as before #816.
      await writeSettings(shopId, { ...DEFAULT_SETTINGS, minPrice: 95, violationPolicy: "block" });
      expect(await breachPolicyOf(shopId, await campaignOf(id))).toEqual({ policy: "block", kept: false, store: "block" });
      const blocked = await preview(shopId, id);
      expect(blocked.blocked?.message).toContain(
        'Lower the floor in Settings, take these 3 variants out of the campaign\'s products, or set "When a price would breach a floor" to clamp or skip instead of blocking.',
      );

      // Back to Clamp, applied, and then Block saved: it keeps the one it started with.
      await writeSettings(shopId, { ...DEFAULT_SETTINGS, minPrice: 95 });
      expect((await applyOf(chaos, id)).clean).toBe(true);
      expect([...chaos.livePrices().values()]).toEqual(["95.00", "95.00", "95.00"]);
      await writeSettings(shopId, { ...DEFAULT_SETTINGS, minPrice: 95, violationPolicy: "block" });
      expect(await breachPolicyOf(shopId, await campaignOf(id))).toEqual({ policy: "clamp", kept: true, store: "block" });
      expect((await preview(shopId, id)).blocked).toBeUndefined();
    });
  });
});
