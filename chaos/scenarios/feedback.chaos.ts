/**
 * Feedback, and the loop closing on it.
 *
 * Not a pricing path, so the risk is different: nothing here can mis-price a storefront.
 * What it can do is quietly lose a merchant's message, or leave it looking unread for
 * ever — which is how a beta programme stops producing anything worth reading.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { withChaos } from "../harness/scenario";

describe("chaos: feedback from inside the app", () => {
  it("captures the context rather than asking for it", async () => {
    await withChaos(
      "feedback-context",
      { catalog: { products: 7, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const { shopId } = chaos.fixture;

        const { recordFeedback } = await import("../../app/services/feedback.server");
        const result = await recordFeedback(shopId, "The preview is slow", "problem", {
          route: "/app/campaigns/new",
        });

        expect(result.ok).toBe(true);

        // Everything a triager needs, none of it asked for. Which screen, which plan,
        // how big the catalogue — all known already, and every question a form asks is
        // a reason somebody closes it instead of sending.
        const stored = await prisma.feedback.findFirstOrThrow({ where: { shopId } });
        expect(stored.route).toBe("/app/campaigns/new");
        expect(stored.planTier).toBe("WHOLESALE");
        expect(stored.variantCount).toBe(7);
        expect(stored.status).toBeNull();
      },
    );
  });

  it("refuses an empty message without losing anything", async () => {
    await withChaos(
      "feedback-empty",
      { catalog: { products: 2, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const { recordFeedback } = await import("../../app/services/feedback.server");
        const result = await recordFeedback(chaos.fixture.shopId, "   ", "idea");

        expect(result.ok).toBe(false);
        expect(
          await prisma.feedback.count({ where: { shopId: chaos.fixture.shopId } }),
        ).toBe(0);
      },
    );
  });

  it("truncates a very long message rather than rejecting it", async () => {
    await withChaos(
      "feedback-long",
      { catalog: { products: 2, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const { recordFeedback, MAX_MESSAGE } = await import(
          "../../app/services/feedback.server"
        );

        // Somebody who has written two thousand words about a problem should not lose
        // them to a validation error.
        const result = await recordFeedback(
          chaos.fixture.shopId,
          "x".repeat(MAX_MESSAGE * 2),
          "problem",
        );

        expect(result.ok).toBe(true);
        const stored = await prisma.feedback.findFirstOrThrow({
          where: { shopId: chaos.fixture.shopId },
        });
        expect(stored.message).toHaveLength(MAX_MESSAGE);
      },
    );
  });

  it("surfaces untriaged items and stops surfacing them once decided", async () => {
    await withChaos(
      "feedback-triage",
      { catalog: { products: 2, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const { shopId } = chaos.fixture;
        const { recordFeedback, triage, untriaged, themes, awaitingNotice } = await import(
          "../../app/services/feedback.server"
        );

        await recordFeedback(shopId, "Please add bulk cost editing", "idea");
        const item = await prisma.feedback.findFirstOrThrow({ where: { shopId } });

        expect((await untriaged()).some((row) => row.id === item.id)).toBe(true);

        await triage(item.id, "p6", "cost editing");

        // An item with a decision leaves the queue. An item without one is what the
        // weekly review exists to catch, so it must not be possible to lose it there.
        expect((await untriaged()).some((row) => row.id === item.id)).toBe(false);
        expect(await themes()).toContainEqual({ theme: "cost editing", count: 1 });

        // Shipping it puts the merchant on the list of people owed an answer — the
        // thing that is easiest in the world to forget, hence a query rather than a
        // habit.
        await triage(item.id, "shipped", "cost editing");
        expect((await awaitingNotice()).some((row) => row.id === item.id)).toBe(true);

        const { markNotified } = await import("../../app/services/feedback.server");
        await markNotified([item.id]);
        expect((await awaitingNotice()).some((row) => row.id === item.id)).toBe(false);
      },
    );
  });
});
