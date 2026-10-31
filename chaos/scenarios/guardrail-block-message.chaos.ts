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
 *
 * Through the campaign's real preview, the real run, and Flow's Start campaign through its
 * route, with only `authenticate` replaced (no signed request) and Flow's admin the chaos client.
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { AppError } from "../../app/lib/errors/app-error";
import { breachPolicyOf } from "../../app/services/campaigns/model.server";
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

/** Flow's Start campaign for the fixture campaign, through the route, and what Flow is told. */
async function flowStart(chaos: ChaosContext) {
  flowRequest = {
    shop: chaos.fixture.domain,
    properties: { "campaign-id": chaos.fixture.campaignId },
    admin: { __chaos: chaosAdminClient(endpoint) },
  };
  const { action } = await import("../../app/routes/flow.actions.start-campaign");
  const response = (await action({
    request: new Request("https://example.invalid/flow/actions/start-campaign", { method: "POST" }),
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
      expect(draftFlow.status).toBe(422);
      expect(draftFlow.message).toContain(SETTING);
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
      expect(flow.status).toBe(422);
      const kept = { preview: await previewSays(), run: await refusal(), flow: flow.message };
      for (const [where, said] of Object.entries(kept)) {
        expect(said, where).toContain('This campaign started under "Block the whole campaign" and keeps that until it ends');
        expect(said, where).toContain(
          "Lower or remove the floor in Settings, or revert the campaign and apply it again, so it starts under the store's " +
            'policy now, "Clamp it to the floor and carry on".',
        );
        expect(said, `${where} told a running campaign to change a setting that does not reach it`).not.toContain(SETTING);
      }
      expect(kept.flow).toBe(`"${(await campaign()).name}" was not applied: ${kept.run}`);
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
});
