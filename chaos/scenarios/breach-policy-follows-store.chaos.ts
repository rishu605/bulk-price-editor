/**
 * A campaign that has not started follows the store's floor-breach policy, and one already
 * running keeps the one it started with (#789).
 *
 * "QA · scheduled" on DartMode Labs was made under the default, Clamp. The merchant set a
 * minimum price and chose Block the whole campaign, and its preview still read "Clamped 1":
 * the policy was copied onto every campaign when it was made, and only the floors were read
 * live, so Block reached no campaign that already existed.
 *
 * Driven through the real preview, the real `tick`, the campaign page's Apply
 * (`runCampaign`) and Settings' list. Replaced: `adminClientForShop` (the fixture shop has no
 * Shopify session) and `notify` (a recorder).
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import type { AppError } from "../../app/lib/errors/app-error";
import { startRefusal } from "../../app/lib/scheduling/start-refusal";
import { breachPolicyOf, keepingOtherPolicies } from "../../app/services/campaigns/model.server";
import { previewCampaign } from "../../app/services/campaigns/preview.server";
import { tick } from "../../app/services/scheduler.server";
import { DEFAULT_SETTINGS, writeSettings } from "../../app/services/settings.server";
import { type ChaosContext, fixtureAdminClient, withChaos } from "../harness/scenario";

let endpoint = "";
vi.mock("../../app/services/admin-client.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/services/admin-client.server")>();
  return { ...actual, adminClientForShop: async (domain: string) => fixtureAdminClient(domain, endpoint) };
});
vi.mock("../../app/services/notifications.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../app/services/notifications.server")>()),
  notify: async () => ({ sent: true }),
}));

const HOUR = 60 * 60_000;
const CATALOG = { catalog: { products: 3, variantsPerProduct: 1 }, percent: -20 } as const;

/**
 * Every baseline at $100, so 20% off is $80 and a $95 minimum sits between the sale price and
 * the normal one: Clamp writes $95, Block stops the campaign. (A floor over the normal price is
 * a different case, which a discount leaves alone whatever the policy: #740.)
 */
async function underAFloor(chaos: ChaosContext) {
  await prisma.baseline.updateMany({ where: { shopId: chaos.fixture.shopId, supersededAt: null }, data: { basePrice: 10_000n } });
}

/** The fixture campaign SCHEDULED, its start five minutes ago: the next tick starts it. */
async function dueToStart(chaos: ChaosContext) {
  endpoint = chaos.server.endpoint();
  const { campaignId } = chaos.fixture;
  const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
  const startAt = new Date(Date.now() - 5 * 60_000);
  const endAt = new Date(Date.now() + 24 * HOUR);
  await prisma.campaign.update({
    where: { id: campaignId },
    data: {
      status: "SCHEDULED",
      startAt,
      endAt,
      schedule: { ...(campaign.schedule as object), kind: "window", startAt: startAt.toISOString(), endAt: endAt.toISOString() } as never,
    },
  });
}

const campaignOf = (id: string) => prisma.campaign.findUniqueOrThrow({ where: { id } });

describe("chaos: the floor-breach policy a campaign runs with (#789)", () => {
  it("is the store's for a scheduled campaign made under Clamp: its preview, its scheduled start and its Apply all block", async () => {
    await withChaos("breach-policy-scheduled", CATALOG, async (chaos) => {
      const { shopId, campaignId } = chaos.fixture;
      expect((await campaignOf(campaignId)).guardrailViolationPolicy, "the fixture was not made under Clamp").toBe("clamp");
      await underAFloor(chaos);
      await dueToStart(chaos);

      // The merchant's save, after the campaign was made: a minimum, and Block.
      await writeSettings(shopId, { ...DEFAULT_SETTINGS, minPrice: 95, violationPolicy: "block" });
      expect(await breachPolicyOf(shopId, await campaignOf(campaignId))).toEqual({ policy: "block", kept: false, store: "block" });

      const preview = await previewCampaign(shopId, campaignId, { limit: 100 });
      expect(preview.blocked?.message, "the preview clamped under Block").toMatch(
        /^A guardrail set to block the whole campaign would stop it before anything is written: .*under its \$95\.00 floor/,
      );
      expect(preview.counts.clamped).toBe(0);

      // The scheduler's start plans as the preview did, and is stopped before anything is written.
      await tick(new Date());
      const refused = await campaignOf(campaignId);
      expect(refused.status, "the start was not given back").toBe("SCHEDULED");
      expect(startRefusal(refused.schedule)).toMatch(/^A guardrail stopped this run before anything was written: /);
      expect(await prisma.campaignRun.count({ where: { campaignId } })).toBe(0);
      expect(chaos.fake.writeLog, "a blocked start wrote").toHaveLength(0);

      // So does Apply on its page.
      const pressed = await chaos.apply().then(
        () => null,
        (error: unknown) => error as AppError,
      );
      expect(pressed?.code, "Apply ran under Clamp").toBe("GUARDRAIL_BLOCKED");
      expect((await campaignOf(campaignId)).status).toBe("SCHEDULED");
      expect(chaos.fake.writeLog).toHaveLength(0);

      // And it follows the store back: Clamp again, and the preview clamps.
      await writeSettings(shopId, { ...DEFAULT_SETTINGS, minPrice: 95 });
      const clamped = await previewCampaign(shopId, campaignId, { limit: 100 });
      expect(clamped.blocked).toBeUndefined();
      expect(clamped.counts.clamped).toBe(3);
    });
  });

  it("is the one it started with for a campaign already active: it keeps Clamp under the store's Block", async () => {
    await withChaos("breach-policy-active", CATALOG, async (chaos) => {
      const { shopId, campaignId } = chaos.fixture;
      await underAFloor(chaos);
      await writeSettings(shopId, { ...DEFAULT_SETTINGS, minPrice: 95 });

      const applied = await chaos.apply();
      expect(applied.clean).toBe(true);
      await chaos.expectHonest(await chaos.latestRunId("APPLY"));
      expect([...chaos.livePrices().values()], "applied under Clamp, at the floor").toEqual(["95.00", "95.00", "95.00"]);

      // Block saved while it runs: its prices are already up, and it keeps what it started with.
      await writeSettings(shopId, { ...DEFAULT_SETTINGS, minPrice: 95, violationPolicy: "block" });
      expect(await breachPolicyOf(shopId, await campaignOf(campaignId))).toEqual({ policy: "clamp", kept: true, store: "block" });
      expect((await previewCampaign(shopId, campaignId, { limit: 100 })).blocked, "a running campaign took the store's Block").toBeUndefined();

      // Applied again -- what a resume or a held campaign's re-apply is -- it is not blocked.
      const again = await chaos.apply();
      expect(again.clean, "a running campaign was blocked by the store's new policy").toBe(true);
      expect((await campaignOf(campaignId)).status).toBe("ACTIVE");
      expect((await campaignOf(campaignId)).guardrailViolationPolicy).toBe("clamp");
      expect([...chaos.livePrices().values()]).toEqual(["95.00", "95.00", "95.00"]);

      // Settings names it beside the field, as running with a policy of its own.
      const keeping = await keepingOtherPolicies(shopId, "block");
      expect(keeping.total).toBe(1);
      expect(keeping.campaigns).toEqual([{ id: campaignId, name: (await campaignOf(campaignId)).name, policy: "clamp" }]);
      expect((await keepingOtherPolicies(shopId, "clamp")).total, "a campaign on the saved policy was listed").toBe(0);
    });
  });
});
