/**
 * A campaign that fails before its run starts must not be left claiming to be applying.
 *
 * `runCampaign` moves the campaign to APPLYING before anything is planned, so that an
 * illegal action is refused before a price moves. Planning can then fail, and until
 * this was fixed every such failure left the campaign in APPLYING forever: the ledger
 * empty, no run row, revert refused because APPLYING -> REVERTING is not a legal edge,
 * and the dashboard reporting a run in progress that no worker was working on.
 *
 * `PRICES_MAY_BE_LIVE` includes APPLYING, so the whole app believed the storefront
 * might be carrying this campaign's prices. That is a state the product exists to make
 * impossible: clean, or visibly partial, never a claim nobody can act on.
 *
 * The trigger used here is a blocking guardrail, deliberately, because it is the
 * ordinary case rather than an exotic one. `planRun` returning `blocked` *throws*, so a
 * merchant's floor price doing exactly its job stranded the campaign every time. It was
 * found via a much rarer failure (#324, a catalogue too large for one statement), but
 * fixing only that would have left the common path broken.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { breachPolicyOf, createCampaign } from "../../app/services/campaigns/model.server";
import { DEFAULT_SETTINGS, writeSettings } from "../../app/services/settings.server";
import { withChaos } from "../harness/scenario";

describe("chaos: a run that never starts gives the campaign back", () => {
  it("leaves a guardrail-blocked campaign actionable instead of stuck applying", async () => {
    await withChaos(
      "stranded-claim",
      { catalog: { products: 3, variantsPerProduct: 2 }, percent: -20 },
      async (ctx) => {
        const { shopId, campaignId } = ctx.fixture;

        const before = await prisma.campaign.findUniqueOrThrow({
          where: { id: campaignId },
          select: { status: true },
        });

        // A floor above every price in the catalogue, set to block rather than clamp.
        // Blocking is the merchant saying "do not quietly do something else" -- which
        // is exactly why it must not quietly break the campaign either.
        //
        // The shop's setting: the fixture's campaign has not started, so it follows it
        // (#789). Only a running campaign keeps the policy it started with.
        await writeSettings(shopId, { ...DEFAULT_SETTINGS, minPrice: 100_000, violationPolicy: "block" });

        await expect(ctx.apply()).rejects.toThrow(/guardrail/i);

        const after = await prisma.campaign.findUniqueOrThrow({
          where: { id: campaignId },
          select: { status: true },
        });

        expect(
          after.status,
          "a campaign that never ran must go back where it was, not sit in APPLYING",
        ).toBe(before.status);

        // Nothing was written, and nothing pretends to have been.
        const runs = await prisma.campaignRun.count({ where: { campaignId } });
        expect(runs, "no run started, so no run row should exist").toBe(0);

        const ledger = await prisma.variantChange.count({ where: { shopId } });
        expect(ledger, "ledger before write (I4) -- nothing planned means nothing ledgered").toBe(0);

        // The audit trail says what happened, so the state change is explainable.
        const entry = await prisma.auditLogEntry.findFirst({
          where: { shopId, entityId: campaignId, action: "campaign.transition" },
          orderBy: { createdAt: "desc" },
        });
        const reason = (entry?.after as { reason?: string } | null)?.reason ?? "";
        expect(reason, "the release must be distinguishable from a normal transition").toMatch(
          /claim released without running/,
        );
      },
    );
  });

  it("recovers: with the guardrail lifted, the same campaign applies cleanly", async () => {
    await withChaos(
      "stranded-claim-recovers",
      { catalog: { products: 3, variantsPerProduct: 2 }, percent: -20 },
      async (ctx) => {
        const { shopId, campaignId } = ctx.fixture;

        await writeSettings(shopId, { ...DEFAULT_SETTINGS, minPrice: 100_000, violationPolicy: "block" });
        await expect(ctx.apply()).rejects.toThrow(/guardrail/i);

        // The point of releasing the claim: the merchant fixes the floor and retries.
        // Before the fix this second apply was the *only* way out, and revert was not
        // available at all.
        await writeSettings(shopId, DEFAULT_SETTINGS);

        const outcome = await ctx.apply();
        expect(outcome.clean, "the retry must be an ordinary clean run").toBe(true);
        expect(outcome.verified).toBe(6);

        const after = await prisma.campaign.findUniqueOrThrow({
          where: { id: campaignId },
          select: { status: true },
        });
        expect(after.status).toBe("ACTIVE");

        await ctx.expectHonest(await ctx.latestRunId("APPLY"));
      },
    );
  });
});

describe("chaos: the floor-violation policy reaches the resolver", () => {
  it("copies the shop's setting onto a campaign when it is created", async () => {
    await withChaos(
      "violation-policy-copied",
      { catalog: { products: 1, variantsPerProduct: 1 }, percent: -10 },
      async (ctx) => {
        const { shopId } = ctx.fixture;

        await writeSettings(shopId, { ...DEFAULT_SETTINGS, violationPolicy: "skip" });

        const created = await createCampaign(shopId, {
          name: "Reads the setting",
          rule: { kind: "percent-change", percent: -10 },
          compareAtPolicy: { kind: "leave" },
          rounding: { default: "none", byCurrency: {} },
          ast: { groups: [] },
          schedule: { kind: "manual" },
        } as never);

        expect(
          created.guardrailViolationPolicy,
          "a merchant who chose skip must not get a campaign that clamps",
        ).toBe("skip");
      },
    );
  });

  it("lets a campaign that has not started follow the shop's setting when it changes (#789)", async () => {
    await withChaos(
      "violation-policy-follows",
      { catalog: { products: 1, variantsPerProduct: 1 }, percent: -10 },
      async (ctx) => {
        const { shopId } = ctx.fixture;

        await writeSettings(shopId, { ...DEFAULT_SETTINGS, violationPolicy: "block" });
        const created = await createCampaign(shopId, {
          name: "Created under block",
          rule: { kind: "percent-change", percent: -10 },
          compareAtPolicy: { kind: "leave" },
          rounding: { default: "none", byCurrency: {} },
          ast: { groups: [] },
          schedule: { kind: "manual" },
        } as never);

        // It has nothing on a storefront to keep a policy for, so the shop's new one is its
        // own. A running campaign keeps the one it started with: `breach-policy-follows-store`.
        await writeSettings(shopId, { ...DEFAULT_SETTINGS, violationPolicy: "clamp" });

        const after = await prisma.campaign.findUniqueOrThrow({ where: { id: created.id } });
        expect(await breachPolicyOf(shopId, after)).toEqual({ policy: "clamp", kept: false, store: "clamp" });
      },
    );
  });

  it("falls back to clamp on a policy string it does not recognise", async () => {
    await withChaos(
      "violation-policy-unknown",
      { catalog: { products: 2, variantsPerProduct: 1 }, percent: -10 },
      async (ctx) => {
        const { shopId, campaignId } = ctx.fixture;

        // A floor between the discounted price and the normal one: $100 baselines, 10% off
        // makes $90, and the floor will be $95. Clamping is "don't discount past this" -- a
        // floor above the baseline is a different case, which a discount leaves alone (#740).
        await prisma.baseline.updateMany({ where: { shopId, supersededAt: null }, data: { basePrice: 10_000n } });
        expect((await ctx.apply()).clean).toBe(true);

        // On a running campaign, which reads its own (#789): an older row, a rolled-back
        // release, a hand-edited record. Refusing to resolve would put the merchant's live
        // prices out of our reach entirely, which is worse than the safest valid answer --
        // and the shop's Block is not its answer either, since it is already running.
        await prisma.campaign.update({
          where: { id: campaignId },
          data: { guardrailViolationPolicy: "obliterate" },
        });
        await writeSettings(shopId, { ...DEFAULT_SETTINGS, minPrice: 95, violationPolicy: "block" });

        const outcome = await ctx.apply();
        expect(outcome.clean, "an unknown policy must not stop the run").toBe(true);
        expect(outcome.verified).toBe(2);

        // Clamped to the floor, not blocked and not skipped.
        const live = [...ctx.livePrices().values()];
        expect(live, "every price clamped to the same floor").toEqual(["95.00", "95.00"]);
      },
    );
  });
});
