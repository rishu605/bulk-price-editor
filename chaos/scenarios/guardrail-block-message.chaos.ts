/**
 * A campaign a blocking guardrail stops says which variants, why in words, and what to do
 * (#1076).
 *
 * It said "Blocked by a guardrail on gid://shopify/ProductVariant/46172975726826:
 * below-floor": an id nobody can find, a code, no next step, and only the first variant --
 * fix that one, and the next one blocked.
 *
 * And what to do is what reaches the campaign (#1161). One that had started under Block was
 * told to set Clamp or Skip in Settings, which reaches a campaign only until it starts (D21).
 * So was one stopped by another running campaign's kept Block, which neither the setting nor
 * anything done to the campaign planned reaches: that one is named now (#1169).
 *
 * Through the campaign's real preview, the real run, and Flow's Start and End campaign through
 * their routes, with only `authenticate` replaced (no signed request) and Flow's admin the chaos
 * client. Every run Flow starts is the worker's since D29 (#808), and a block is found by
 * planning, so Flow hears it queued; the worker's refusal is what the campaign then says
 * (#1046), in the same sentence. There is no worker queue here: the worker's tick runs it.
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { AppError } from "../../app/lib/errors/app-error";
import { queuedRefusal } from "../../app/lib/campaigns/queued-refusal";
import { ringQueuedRuns, STRANDED_RUN_AFTER_MS } from "../../app/services/campaigns/queued-run.server";
import { inlineRuntime } from "../../app/worker/queue-runtime.server";
import type { JobRef, QueueName } from "../../app/worker/queues";
import { breachPolicyOf, createCampaign } from "../../app/services/campaigns/model.server";
import { previewCampaign } from "../../app/services/campaigns/preview.server";
import { runCampaign } from "../../app/services/campaigns/run.server";
import { DEFAULT_SETTINGS, writeSettings } from "../../app/services/settings.server";
import { chaosAdminClient } from "../harness/http-client";
import { type ChaosContext, fixtureAdminClient, withChaos } from "../harness/scenario";

let flowRequest: { shop: string; properties: Record<string, string>; admin?: unknown } = { shop: "", properties: {} };
let endpoint = "";

vi.mock("../../app/shopify.server", () => ({
  authenticate: {
    flow: async () => ({ session: { shop: flowRequest.shop }, payload: { properties: flowRequest.properties }, admin: flowRequest.admin }),
  },
}));

vi.mock("../../app/services/admin-client.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/services/admin-client.server")>();
  return {
    ...actual,
    adminClientForShop: async (domain: string) => fixtureAdminClient(domain, endpoint),
    // The route hands Flow's `admin` to this; in the scenario that admin is the chaos client.
    toAdminClient: (admin: unknown) =>
      (admin as { __chaos?: unknown })?.__chaos ?? actual.toAdminClient(admin as never),
  };
});

vi.mock("../../app/worker/web-queue.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../app/worker/web-queue.server")>()),
  webQueue: () => null,
}));

async function worker(name: QueueName, ref: JobRef) {
  const { handleJob } = await import("../../app/worker/handlers.server");
  return handleJob(name, ref);
}

/** The worker's tick runs what Flow queued; what the campaign then says of its refusal (#1046). */
async function refusedInTheWorker(chaos: ChaosContext): Promise<string> {
  const now = new Date(Date.now() + STRANDED_RUN_AFTER_MS + 1_000);
  expect(await ringQueuedRuns(inlineRuntime(worker), worker, { now, shopId: chaos.fixture.shopId })).toBe(1);
  const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: chaos.fixture.campaignId } });
  return queuedRefusal(campaign.schedule)?.reason ?? "";
}

/** Flow's Start campaign for the fixture campaign, through the route, and what Flow is told. */
async function flowStart(chaos: ChaosContext) {
  return flowAction(chaos, "start-campaign", await import("../../app/routes/flow.actions.start-campaign"));
}

/** Flow's End campaign, likewise. */
async function flowEnd(chaos: ChaosContext) {
  return flowAction(chaos, "end-campaign", await import("../../app/routes/flow.actions.end-campaign"));
}

async function flowAction(chaos: ChaosContext, name: string, route: { action: (args: never) => Promise<unknown> }) {
  flowRequest = {
    shop: chaos.fixture.domain,
    properties: { "campaign-id": chaos.fixture.campaignId },
    admin: { __chaos: chaosAdminClient(endpoint) },
  };
  const response = (await route.action({
    request: new Request(`https://example.invalid/flow/actions/${name}`, { method: "POST" }),
    params: {},
    context: {},
  } as never)) as Response;
  return { status: response.status, message: ((await response.json()) as { message: string }).message };
}

/** What a campaign the store's setting still reaches is offered, as it was before #1161. */
const SETTING = 'or set "When a price would breach a floor" to clamp or skip instead of blocking.';

describe("chaos: a campaign a blocking guardrail stops", () => {
  it("names every variant it stops, with its price and its floor, in the preview and in the run's refusal", async () => {
    await withChaos("guardrail-block-message", { catalog: { products: 3, variantsPerProduct: 1 }, percent: -10 }, async (chaos) => {
      const { shopId, campaignId, variantGids } = chaos.fixture;
      const names = ["Cascade Gloves · S", "Cascade Gloves · M", "Cascade Gloves · L"];
      for (const [i, gid] of variantGids.entries()) {
        await prisma.variantIndex.updateMany({ where: { shopId, variantGid: gid }, data: { title: names[i] } });
      }
      // A floor above every price, and the whole campaign blocked by it: the store's setting,
      // which a campaign that has not started follows (#789).
      await writeSettings(shopId, { ...DEFAULT_SETTINGS, minPrice: 100_000, violationPolicy: "block" });

      const preview = await previewCampaign(shopId, campaignId, { limit: 100 });
      const said = preview.blocked?.message ?? "";
      expect(said).toMatch(/^A guardrail set to block the whole campaign would stop it before anything is written: /);
      for (const name of names) expect(said, `the preview left out ${name}`).toContain(`"${name}" would be $`);
      expect(said).toContain("under its $100,000.00 floor");
      expect(said).not.toMatch(/gid:\/\/|below-floor/);
      expect(said).toContain("take these 3 variants out of the campaign's products");

      const refused = await runCampaign(shopId, campaignId, chaosAdminClient(chaos.server.endpoint()), { actor: "chaos" }).then(
        () => null,
        (error: unknown) => error,
      );
      expect(refused, "the run's refusal is not a guardrail error").toBeInstanceOf(AppError);
      expect((refused as AppError).code).toBe("GUARDRAIL_BLOCKED");
      const run = (refused as AppError).userMessage;
      expect(run).toMatch(/^A guardrail stopped this run before anything was written: /);
      for (const name of names) expect(run).toContain(`"${name}" would be $`);
      expect(run).not.toMatch(/gid:\/\/|below-floor/);
      expect(chaos.fake.writeLog, "a blocked campaign wrote").toHaveLength(0);
    });
  });

  it("tells one that started under Block what still reaches it, and a draft what it always did (#1161)", async () => {
    await withChaos("guardrail-block-kept", { catalog: { products: 3, variantsPerProduct: 1 }, percent: -10 }, async (chaos) => {
      const { shopId, campaignId } = chaos.fixture;
      endpoint = chaos.server.endpoint();
      const client = chaosAdminClient(endpoint);
      const campaign = () => prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
      const previewSays = async () => (await previewCampaign(shopId, campaignId, { limit: 100 })).blocked?.message ?? "";
      const refusal = async (options: { resume?: boolean } = {}) => {
        const refused = await runCampaign(shopId, campaignId, client, { actor: "chaos", ...options }).then(
          () => null,
          (error: unknown) => error,
        );
        expect(refused, "the run was not refused by the guardrail").toBeInstanceOf(AppError);
        expect((refused as AppError).code).toBe("GUARDRAIL_BLOCKED");
        return (refused as AppError).userMessage;
      };

      // A draft, under the store's Block and a floor over every price: the setting reaches it.
      await writeSettings(shopId, { ...DEFAULT_SETTINGS, minPrice: 100_000, violationPolicy: "block" });
      expect(await previewSays()).toContain(SETTING);
      expect(await refusal()).toContain(SETTING);
      const draftFlow = await flowStart(chaos);
      expect(draftFlow.status, "Flow's start is queued, and its plan is the worker's").toBe(200);
      expect(await refusedInTheWorker(chaos)).toContain(SETTING);
      expect((await campaign()).status, "a blocked apply kept the draft's claim").toBe("DRAFT");
      expect(chaos.fake.writeLog, "a blocked draft wrote").toHaveLength(0);

      // Started under Block with no floor in the way, then a floor over every price, and Clamp
      // saved in Settings: the live case. It keeps Block until it ends.
      await writeSettings(shopId, { ...DEFAULT_SETTINGS, violationPolicy: "block" });
      expect((await chaos.apply()).clean).toBe(true);
      await chaos.expectHonest(await chaos.latestRunId("APPLY"));
      const written = chaos.fake.writeLog.length;
      await writeSettings(shopId, { ...DEFAULT_SETTINGS, minPrice: 100_000 });
      expect(await breachPolicyOf(shopId, await campaign())).toEqual({ policy: "block", kept: true, store: "clamp" });

      // Its preview, a re-apply from its page and Flow's Start campaign all say so, and what
      // reaches it instead -- never the setting it no longer follows.
      const flow = await flowStart(chaos);
      expect(flow.status).toBe(200);
      const queued = await refusedInTheWorker(chaos);
      expect((await campaign()).status, "a blocked re-apply did not give the campaign back").toBe("ACTIVE");
      const kept = { preview: await previewSays(), run: await refusal(), flow: queued };
      for (const [where, said] of Object.entries(kept)) {
        expect(said, where).toContain('This campaign started under "Block the whole campaign" and keeps that until it ends');
        expect(said, where).toContain(
          "Lower or remove the floor in Settings, or revert the campaign and apply it again, so it starts under the store's " +
            'policy now, "Clamp it to the floor and carry on".',
        );
        expect(said, `${where} told a running campaign to change a setting that does not reach it`).not.toContain(SETTING);
      }
      expect(kept.flow, "the worker's refusal is not the run's sentence").toBe(kept.run);
      expect((await campaign()).status, "a blocked re-apply did not give the campaign back").toBe("ACTIVE");

      // A resume says the same: stopped part-way is started.
      await prisma.campaign.update({ where: { id: campaignId }, data: { status: "PARTIAL" } });
      expect(await refusal({ resume: true })).toBe(kept.run);
      expect((await campaign()).status).toBe("PARTIAL");

      // With Block saved too, starting again would block again: the setting comes first.
      await writeSettings(shopId, { ...DEFAULT_SETTINGS, minPrice: 100_000, violationPolicy: "block" });
      expect(await refusal({ resume: true })).toContain(
        'Lower or remove the floor in Settings, or set "When a price would breach a floor" to clamp or skip, then revert the campaign and apply it again.',
      );
      expect(chaos.fake.writeLog, "a blocked run wrote").toHaveLength(written);
    });
  });

  it("names the running campaign kept on Block that stops a revert, or a draft, and what reaches it (#1169)", async () => {
    await withChaos("guardrail-block-other", { catalog: { products: 3, variantsPerProduct: 1 }, percent: -10 }, async (chaos) => {
      const { shopId, campaignId } = chaos.fixture;
      endpoint = chaos.server.endpoint();
      const client = chaosAdminClient(endpoint);
      const campaign = () => prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
      const refusal = async (options: { revert?: boolean } = {}) => {
        const refused = await runCampaign(shopId, campaignId, client, { actor: "chaos", ...options }).then(
          () => null,
          (error: unknown) => error,
        );
        expect(refused, "the run was not refused by the guardrail").toBeInstanceOf(AppError);
        expect((refused as AppError).code).toBe("GUARDRAIL_BLOCKED");
        return (refused as AppError).userMessage;
      };
      /** What every one of them says, and none of the advice that reaches nothing stopping it. */
      const namesWinter = (said: Record<string, string>, store: "clamp" | "block" = "clamp") => {
        for (const [where, text] of Object.entries(said)) {
          expect(text, where).toContain('in "Winter Sale", under its');
          expect(text, where).toContain(
            '"Winter Sale" is a running campaign that started under "Block the whole campaign" and keeps that until it ends',
          );
          expect(text, where).toContain(
            store === "clamp"
              ? 'Lower or remove the floor in Settings, or revert "Winter Sale" and apply it again, so it starts under the ' +
                  'store\'s policy now, "Clamp it to the floor and carry on".'
              : 'Lower or remove the floor in Settings, or set "When a price would breach a floor" to clamp or skip, then ' +
                  'revert "Winter Sale" and apply it again.',
          );
          expect(text, `${where} told it to change a setting that does not reach "Winter Sale"`).not.toContain(SETTING);
          expect(text, `${where} told it to take out variants that are not what stops it`).not.toContain("campaign's products");
        }
        // The preview's sentence is the run's after its opening: one sentence, from one place.
        const after = (text: string) => text.slice(text.indexOf(": ") + 2);
        if (said.preview && said.run) expect(after(said.preview)).toBe(after(said.run));
      };

      // "Winter Sale", 30% off the same variants, started under the store's Block with no floor in
      // the way. It keeps Block until it ends.
      await writeSettings(shopId, { ...DEFAULT_SETTINGS, violationPolicy: "block" });
      const winter = await createCampaign(shopId, {
        name: "Winter Sale",
        priority: 500,
        rule: { kind: "percent-change", percent: -30 },
        compareAtPolicy: { kind: "leave" },
        rounding: { default: "none", byCurrency: {} },
        ast: { groups: [{ conditions: [{ field: "tag", value: "chaos" }] }] },
        schedule: { kind: "manual" },
      } as never);
      expect((await runCampaign(shopId, winter.id, client, { actor: "chaos", verifySampleRate: 1 })).clean).toBe(true);

      // Then a floor over every price, and Clamp saved in Settings.
      await writeSettings(shopId, { ...DEFAULT_SETTINGS, minPrice: 100_000 });
      expect(await breachPolicyOf(shopId, await prisma.campaign.findUniqueOrThrow({ where: { id: winter.id } }))).toEqual({
        policy: "block",
        kept: true,
        store: "clamp",
      });
      const before = chaos.fake.writeLog.length;

      // A draft under it: Winter Sale wins every variant, and its Block stops the draft. The draft
      // follows Clamp, so the setting is not what stops it either.
      await prisma.campaign.update({ where: { id: campaignId }, data: { priority: 100 } });
      const draftFlow = await flowStart(chaos);
      expect(draftFlow.status).toBe(200);
      const queuedDraft = await refusedInTheWorker(chaos);
      const draft = {
        preview: (await previewCampaign(shopId, campaignId, { limit: 100 })).blocked?.message ?? "",
        run: await refusal(),
        flow: queuedDraft,
      };
      namesWinter(draft);
      expect(draft.flow).toBe(draft.run);
      expect((await campaign()).status, "a blocked apply kept the draft's claim").toBe("DRAFT");
      expect(chaos.fake.writeLog, "a blocked draft wrote").toHaveLength(before);

      // Over Winter Sale and applied with no floor in the way, then the floor again.
      await prisma.campaign.update({ where: { id: campaignId }, data: { priority: 900 } });
      await writeSettings(shopId, DEFAULT_SETTINGS);
      await chaos.expectHonest((await chaos.apply()).runId);
      const written = chaos.fake.writeLog.length;
      await writeSettings(shopId, { ...DEFAULT_SETTINGS, minPrice: 100_000 });

      // Its revert hands every variant to Winter Sale, under the floor: the revert's preview, its run
      // and Flow's End campaign name Winter Sale, and what reaches it.
      const endFlow = await flowEnd(chaos);
      expect(endFlow.status).toBe(200);
      const queuedEnd = await refusedInTheWorker(chaos);
      const revert = {
        preview: (await previewCampaign(shopId, campaignId, { limit: 100, revert: true })).blocked?.message ?? "",
        run: await refusal({ revert: true }),
        flow: queuedEnd,
      };
      namesWinter(revert);
      expect(revert.flow).toBe(revert.run);
      expect((await campaign()).status, "a blocked revert did not give the campaign back").toBe("ACTIVE");

      // With Block saved too, starting Winter Sale again would block again: the setting comes first.
      await writeSettings(shopId, { ...DEFAULT_SETTINGS, minPrice: 100_000, violationPolicy: "block" });
      namesWinter({ run: await refusal({ revert: true }) }, "block");
      expect(chaos.fake.writeLog, "a blocked revert wrote").toHaveLength(written);
    });
  });
});
