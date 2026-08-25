/**
 * The promo calendar, against a real engine.
 *
 * The pure layout is tested separately; what this asks is whether the calendar tells the
 * truth about a store that has actually run campaigns. BulkPriceBoard proved merchants
 * want a calendar and then collapsed to 2.1 stars on reliability — a calendar showing a
 * campaign as scheduled when the run behind it went partial is precisely that failure
 * with a nicer grid.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { withChaos } from "../harness/scenario";

describe("chaos: the campaign calendar", () => {
  it("shows what ran, on the day it ran, in the store's zone", async () => {
    await withChaos(
      "calendar-runs",
      { catalog: { products: 4, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const { shopId } = chaos.fixture;

        const applied = await chaos.apply();
        await chaos.expectHonest(applied.runId);
        await chaos.revert();

        const { calendarFor } = await import("../../app/services/calendar.server");
        const { todayIn } = await import("../../app/services/calendar.server");

        const shop = await prisma.shop.findUniqueOrThrow({ where: { id: shopId } });
        const today = todayIn(shop.timezone);
        const calendar = await calendarFor(shopId, shop.timezone, { view: "week", on: today });

        const runs = calendar.days.flatMap((day) => day.runs);
        expect(runs.map((run) => run.kind).sort()).toEqual(["APPLY", "REVERT"]);
        // Both on today's square, because both happened today wherever this store is.
        expect(calendar.days.find((day) => day.date === today)!.runs).toHaveLength(2);
      },
    );
  });

  it("reports how many products two overlapping campaigns actually share", async () => {
    await withChaos(
      "calendar-overlap",
      { catalog: { products: 10, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const { shopId, campaignId, variantGids } = chaos.fixture;

        // Tag half the catalogue and point a second campaign at that half. The two
        // windows cross, and exactly five products are in both — which is the number a
        // merchant needs and cannot work out from a list of campaigns.
        //
        // Added to the fixture's own tag rather than replacing it: replacing it takes
        // those five products *out* of the first campaign's scope, so the two campaigns
        // become genuinely disjoint and the test measures nothing.
        await prisma.variantIndex.updateMany({
          where: { shopId, variantGid: { in: variantGids.slice(0, 5) } },
          data: { tags: ["chaos", "HALF"] },
        });

        const first = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
        const start = new Date();
        const end = new Date(start.getTime() + 3 * 24 * 60 * 60 * 1000);

        // Open-ended: runs until reverted. That makes it overlap everything scheduled
        // after it, which is what gives the visibility filter below something to do.
        await prisma.campaign.update({
          where: { id: campaignId },
          data: { status: "SCHEDULED", startAt: start, endAt: null },
        });

        const second = await prisma.campaign.create({
          data: {
            shopId,
            name: "Half sale",
            status: "SCHEDULED",
            priority: 200,
            startAt: new Date(start.getTime() + 60_000),
            endAt: new Date(end.getTime() + 60_000),
            ruleRows: [{ segmentIds: [], rule: { kind: "percent-change", percent: -30 } }] as never,
            surfaces: { base: true, priceLists: [] } as never,
            compareAtPolicy: { kind: "leave" } as never,
            compareAtViolationPolicy: "clear",
            guardrails: {} as never,
            guardrailViolationPolicy: "clamp",
            schedule: {
              ...(first.schedule as object),
              ast: { groups: [{ conditions: [{ field: "tag", value: "HALF" }] }] },
            } as never,
          },
        });

        // A campaign scoped to a tag nothing carries, running this week. It gives the
        // page a second and third overlap that share no products, so "most entangled
        // first" is a claim with more than one element to order.
        await prisma.campaign.create({
          data: {
            shopId,
            name: "Empty scope",
            status: "SCHEDULED",
            priority: 10,
            startAt: new Date(start.getTime() + 120_000),
            endAt: end,
            ruleRows: first.ruleRows as never,
            surfaces: { base: true, priceLists: [] } as never,
            compareAtPolicy: { kind: "leave" } as never,
            compareAtViolationPolicy: "clear",
            guardrails: {} as never,
            guardrailViolationPolicy: "clamp",
            schedule: {
              ...(first.schedule as object),
              ast: { groups: [{ conditions: [{ field: "tag", value: "NOTHING-HAS-THIS" }] }] },
            } as never,
          },
        });

        // A campaign six months out. It genuinely overlaps the open-ended one above, so
        // it is a real future collision — and it is not what this month's page is
        // answering, so it must not appear here.
        await prisma.campaign.create({
          data: {
            shopId,
            name: "Next year",
            status: "SCHEDULED",
            priority: 50,
            startAt: new Date(start.getTime() + 180 * 24 * 60 * 60 * 1000),
            endAt: null,
            ruleRows: first.ruleRows as never,
            surfaces: { base: true, priceLists: [] } as never,
            compareAtPolicy: { kind: "leave" } as never,
            compareAtViolationPolicy: "clear",
            guardrails: {} as never,
            guardrailViolationPolicy: "clamp",
            schedule: first.schedule as never,
          },
        });

        const { calendarFor, todayIn } = await import("../../app/services/calendar.server");
        const shop = await prisma.shop.findUniqueOrThrow({ where: { id: shopId } });
        const calendar = await calendarFor(shopId, shop.timezone, {
          view: "month",
          on: todayIn(shop.timezone),
        });

        expect(
          calendar.overlaps.some((entry) =>
            [entry.a.name, entry.b.name].includes("Next year"),
          ),
        ).toBe(false);

        // Most entangled first. The pair sharing five products is the one to look at,
        // not the pair sharing none.
        expect(calendar.overlaps.map((entry) => entry.sharedVariants)).toEqual(
          [...calendar.overlaps.map((entry) => entry.sharedVariants)].sort((x, y) => y - x),
        );

        const overlap = calendar.overlaps.find(
          (entry) =>
            [entry.a.id, entry.b.id].includes(campaignId) &&
            [entry.a.id, entry.b.id].includes(second.id),
        );

        expect(overlap).toBeDefined();
        expect(overlap!.sharedVariants).toBe(5);
      },
    );
  });

  it("does not report an overlap between campaigns that merely follow each other", async () => {
    await withChaos(
      "calendar-consecutive",
      { catalog: { products: 4, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const { shopId, campaignId } = chaos.fixture;

        const first = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
        const start = new Date();
        const changeover = new Date(start.getTime() + 24 * 60 * 60 * 1000);

        await prisma.campaign.update({
          where: { id: campaignId },
          data: { status: "SCHEDULED", startAt: start, endAt: changeover },
        });

        // Starts exactly as the first ends. Back-to-back sales are what a merchant
        // means to schedule; flagging them would make the badge constant and therefore
        // worth ignoring.
        await prisma.campaign.create({
          data: {
            shopId,
            name: "Follow-on",
            status: "SCHEDULED",
            priority: 100,
            startAt: changeover,
            endAt: new Date(changeover.getTime() + 24 * 60 * 60 * 1000),
            ruleRows: first.ruleRows as never,
            surfaces: { base: true, priceLists: [] } as never,
            compareAtPolicy: { kind: "leave" } as never,
            compareAtViolationPolicy: "clear",
            guardrails: {} as never,
            guardrailViolationPolicy: "clamp",
            schedule: first.schedule as never,
          },
        });

        const { calendarFor, todayIn } = await import("../../app/services/calendar.server");
        const shop = await prisma.shop.findUniqueOrThrow({ where: { id: shopId } });
        const calendar = await calendarFor(shopId, shop.timezone, {
          view: "month",
          on: todayIn(shop.timezone),
        });

        expect(calendar.overlaps).toHaveLength(0);
      },
    );
  });
});
