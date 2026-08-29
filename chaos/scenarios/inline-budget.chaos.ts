/**
 * A campaign too large for the request that asked for it must be refused, not started.
 *
 * `runCampaign` writes prices inline, so an apply from the campaign page happens during
 * the HTTP request and dies with it. Railway closes a request after five minutes with
 * no data transferred, and a React Router action sends nothing until it returns.
 *
 * The failure that produces is the worst one available: the proxy closes the connection
 * and `runCampaign` carries on writing regardless. The merchant sees an error, and
 * their storefront changes anyway -- prices moved with the app reporting that they did
 * not, which is the single outcome this product exists to prevent.
 *
 * So the check is a refusal *before the claim*: no run row, no ledger row, no price
 * moved, and the campaign still in the state the merchant left it in, ready to be
 * scheduled instead.
 *
 * The limit is a property of the caller, not of the campaign. The worker and the
 * scheduler have no request attached, so they pass no limit and run the same campaign
 * to completion -- which is the second half of what this scenario proves, and the half
 * that makes "schedule it instead" honest advice rather than a brush-off.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { pricesMayBeLive } from "../../app/lib/lifecycle/transitions";
import { withChaos } from "../harness/scenario";

describe("chaos: a run too large for its request is refused, not abandoned halfway", () => {
  it("refuses before the claim and leaves the campaign schedulable", async () => {
    await withChaos(
      "inline-budget",
      { catalog: { products: 4, variantsPerProduct: 3 }, percent: -20 },
      async (ctx) => {
        const { shopId, campaignId } = ctx.fixture;

        const before = await prisma.campaign.findUniqueOrThrow({
          where: { id: campaignId },
          select: { status: true },
        });
        const pricesBefore = ctx.livePrices();

        // Twelve variants against a limit of three. The real limit is 120,000; what is
        // under test is the comparison and everything it protects, not the constant.
        const refused = await ctx.apply({ inlineRowLimit: 3 });

        expect(refused.refused, "a refusal has to say so in the outcome").toBeTruthy();
        expect(refused.refused, "and tell the merchant where to go next").toMatch(
          /schedul/i,
        );
        expect(refused.messages.join(" ")).toContain("12");

        // Clean, because nothing is half-done. An unclean outcome would route this into
        // the needs-attention queue, where there is nothing to attend to.
        expect(refused.clean, "nothing started, so nothing is partial").toBe(true);
        expect(refused.planned).toBe(0);
        expect(refused.verified).toBe(0);

        // Ledger before write (I4), from the other direction: no write, so no row.
        expect(
          await prisma.variantChange.count({ where: { shopId } }),
          "a refused run must not ledger anything",
        ).toBe(0);
        expect(
          await prisma.campaignRun.count({ where: { campaignId } }),
          "no run started, so no run row should exist",
        ).toBe(0);

        const after = await prisma.campaign.findUniqueOrThrow({
          where: { id: campaignId },
          select: { status: true },
        });
        expect(after.status, "refused before the claim, so the state never moved").toBe(
          before.status,
        );
        expect(
          pricesMayBeLive(after.status as never),
          "the app must not believe this campaign's prices might be on the storefront",
        ).toBe(false);

        for (const [gid, price] of pricesBefore) {
          expect(ctx.livePrices().get(gid), `${gid} must not have moved`).toBe(price);
        }

        // The other half: the same campaign, run by a caller with no request attached,
        // goes through. The advice to schedule it is only honest if scheduling works.
        const ran = await ctx.apply();
        expect(ran.clean, "the worker has no deadline, so it runs the same campaign").toBe(
          true,
        );
        expect(ran.verified, "all twelve variants, verified").toBe(12);
      },
    );
  });

  it("never refuses a revert, however large", async () => {
    await withChaos(
      "inline-budget-revert",
      { catalog: { products: 4, variantsPerProduct: 3 }, percent: -20 },
      async (ctx) => {
        const applied = await ctx.apply();
        expect(applied.clean).toBe(true);

        // A limit far below the scope. Refusing here would strand a store at 20% off
        // because it is large -- the guard causing the incident it exists to prevent.
        const reverted = await ctx.revert({ inlineRowLimit: 1 });

        expect(reverted.refused, "a revert is never gated, on anything").toBeFalsy();
        expect(reverted.clean).toBe(true);
        expect(reverted.verified).toBe(12);
      },
    );
  });
});
