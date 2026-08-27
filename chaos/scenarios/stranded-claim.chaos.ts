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
import { createCampaign } from "../../app/services/campaigns/model.server";
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
        // The policy goes on the campaign because that is where resolution reads it
        // (#338): a campaign copies the shop's setting when it is created, so changing
        // the shop default afterwards must not retroactively change a running campaign.
        // The fixture's campaign already exists, so set it directly.
        await writeSettings(shopId, { ...DEFAULT_SETTINGS, minPrice: 100_000 });
        await prisma.campaign.update({
          where: { id: campaignId },
          data: { guardrailViolationPolicy: "block" },
        });

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

        await writeSettings(shopId, { ...DEFAULT_SETTINGS, minPrice: 100_000 });
        await prisma.campaign.update({
          where: { id: campaignId },
          data: { guardrailViolationPolicy: "block" },
        });
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

  it("does not retroactively change a campaign when the shop default changes", async () => {
    await withChaos(
      "violation-policy-frozen",
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

        // Changing the store default must not reach back into a campaign that may
        // already have prices on a storefront.
        await writeSettings(shopId, { ...DEFAULT_SETTINGS, violationPolicy: "clamp" });

        const after = await prisma.campaign.findUniqueOrThrow({
          where: { id: created.id },
          select: { guardrailViolationPolicy: true },
        });
        expect(after.guardrailViolationPolicy).toBe("block");
      },
    );
  });

  it("falls back to clamp on a policy string it does not recognise", async () => {
    await withChaos(
      "violation-policy-unknown",
      { catalog: { products: 2, variantsPerProduct: 1 }, percent: -10 },
      async (ctx) => {
        const { shopId, campaignId } = ctx.fixture;

        // An older row, a rolled-back release, a hand-edited record. Refusing to
        // resolve would put the merchant's live prices out of our reach entirely,
        // which is worse than the safest valid answer.
        await prisma.campaign.update({
          where: { id: campaignId },
          data: { guardrailViolationPolicy: "obliterate" },
        });
        await writeSettings(shopId, { ...DEFAULT_SETTINGS, minPrice: 100_000 });

        const outcome = await ctx.apply();
        expect(outcome.clean, "an unknown policy must not stop the run").toBe(true);
        expect(outcome.verified).toBe(2);

        // Clamped to the floor, not blocked and not skipped.
        const live = [...ctx.livePrices().values()];
        expect(new Set(live).size, "every price clamped to the same floor").toBe(1);
      },
    );
  });
});
