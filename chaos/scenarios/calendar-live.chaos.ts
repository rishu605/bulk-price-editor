/**
 * The calendar shows the sale that is live and stops the one that has finished (#768).
 *
 * On dartmode-labs on 25 Sep the calendar had it exactly backwards. "Sale · 21/09/2026",
 * applied by hand and live on the storefront, was nowhere: a manual campaign has no
 * `startAt`, and the calendar drew schedules. "QA · end before start", set for the 30th
 * with no end and then applied and reverted by hand days earlier, was Completed -- and
 * drawn from the 30th through every day of every later month, because no end reads as
 * "runs until reverted".
 *
 * Driven through the real run path, so the runs the calendar reads are the ones the engine
 * writes: the fixture's own campaign is the manual sale, the other two are made here. The
 * store is put in New York rather than left in UTC, because every day here is the store's.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { addDays, localDate } from "../../app/lib/scheduling/calendar";
import { calendarFor, todayIn } from "../../app/services/calendar.server";
import { createCampaign } from "../../app/services/campaigns/model.server";
import { runCampaign } from "../../app/services/campaigns/run.server";
import { chaosAdminClient } from "../harness/http-client";
import { withChaos } from "../harness/scenario";

const ZONE = "America/New_York";
const DAY = 24 * 60 * 60 * 1000;

/** The same month, or the next, as the calendar's `on`. */
function nextMonth(date: string): string {
  const [year, month] = date.split("-").map(Number);
  const first = new Date(Date.UTC(year, month, 1));
  return first.toISOString().slice(0, 10);
}

/** Every day from `from` to `to`, inclusive. */
function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) out.push(day);
  return out;
}

describe("chaos: the calendar draws what is live and stops what has finished (#768)", () => {
  it("draws a sale applied by hand from the day it went live, ends one reverted by hand where it was reverted, and keeps a schedule to its days", async () => {
    await withChaos(
      "calendar-live",
      { catalog: { products: 4, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const { shopId, campaignId: manualSale, variantGids } = chaos.fixture;
        const client = chaosAdminClient(chaos.server.endpoint());
        await prisma.shop.update({ where: { id: shopId }, data: { timezone: ZONE } });

        const template = {
          compareAtPolicy: { kind: "leave" as const },
          rounding: { default: "none", byCurrency: {} },
        };

        // The sale applied by hand. A manual campaign: no `startAt`, before or after.
        await chaos.expectHonest((await chaos.apply()).runId);
        const live = await prisma.campaign.findUniqueOrThrow({ where: { id: manualSale } });
        expect(live).toMatchObject({ status: "ACTIVE", startAt: null, endAt: null });

        // "QA · end before start": scheduled to start five days out with no end, then
        // applied and reverted by hand today, long before that start. Over half the
        // catalogue and above the manual sale, so its runs genuinely write.
        await prisma.variantIndex.updateMany({
          where: { shopId, variantGid: { in: variantGids.slice(0, 2) } },
          data: { tags: ["chaos", "QA"] },
        });
        const qa = await createCampaign(shopId, {
          ...template,
          name: "QA · end before start",
          priority: 950,
          rule: { kind: "percent-change", percent: -30 },
          ast: { groups: [{ conditions: [{ field: "tag", value: "QA" }] }] },
          schedule: { kind: "window", startAt: new Date(Date.now() + 5 * DAY).toISOString() },
        } as never);
        const qaApply = await runCampaign(shopId, qa.id, client, { actor: "chaos", verifySampleRate: 1 });
        expect(qaApply).toMatchObject({ clean: true, verified: 2 });
        await runCampaign(shopId, qa.id, client, { actor: "chaos", revert: true, verifySampleRate: 1 });

        const finished = await prisma.campaign.findUniqueOrThrow({ where: { id: qa.id } });
        expect(finished.status).toBe("COMPLETED");
        // Still carrying the start it never reached, and no end: the shape that ran forever.
        expect(finished.startAt).not.toBeNull();
        expect(finished.endAt).toBeNull();

        // Black Friday, scheduled ten to thirteen days out. Nothing runs it here.
        const windowStart = new Date(Date.now() + 10 * DAY);
        const windowEnd = new Date(Date.now() + 13 * DAY);
        const scheduled = await createCampaign(shopId, {
          ...template,
          name: "Black Friday",
          priority: 100,
          rule: { kind: "percent-change", percent: -40 },
          ast: { groups: [{ conditions: [{ field: "tag", value: "chaos" }] }] },
          schedule: { kind: "window", startAt: windowStart.toISOString(), endAt: windowEnd.toISOString() },
        } as never);

        // The days each run happened on, from the runs themselves: a scenario run a
        // second before midnight in New York must not fail on which day "today" is.
        const runsOf = (campaignId: string, kind: "APPLY" | "REVERT") =>
          prisma.campaignRun.findFirstOrThrow({
            where: { campaignId, kind },
            orderBy: { createdAt: "desc" },
          });
        const saleLive = localDate((await runsOf(manualSale, "APPLY")).startedAt!, ZONE);
        const qaLive = localDate((await runsOf(qa.id, "APPLY")).startedAt!, ZONE);
        const qaOff = localDate((await runsOf(qa.id, "REVERT")).finishedAt!, ZONE);

        const today = todayIn(ZONE);
        const thisMonth = await calendarFor(shopId, ZONE, { view: "month", on: today });
        const followingMonth = await calendarFor(shopId, ZONE, { view: "month", on: nextMonth(today) });
        const scheduledMonth = await calendarFor(shopId, ZONE, { view: "month", on: localDate(windowStart, ZONE) });

        const daysWith = (calendar: typeof thisMonth, campaignId: string) =>
          calendar.days
            .filter((day) => day.entries.some((entry) => entry.campaignId === campaignId))
            .map((day) => day.date);

        // The live manual sale: on the calendar from the day it was applied, today
        // included, and on every day after it -- it runs until somebody reverts it.
        const saleThisMonth = daysWith(thisMonth, manualSale);
        expect(saleThisMonth[0]).toBe(saleLive);
        expect(saleThisMonth).toEqual(daysBetween(saleLive, thisMonth.to));
        expect(saleThisMonth).toContain(today);
        expect(daysWith(followingMonth, manualSale)).toEqual(followingMonth.days.map((day) => day.date));
        const onToday = thisMonth.days
          .find((day) => day.date === today)!
          .entries.find((entry) => entry.campaignId === manualSale)!;
        expect(onToday.status).toBe("ACTIVE");

        // The finished one: on the day it was live and reverted, and nowhere else --
        // not on the start it never reached, not on any day of next month.
        expect(daysWith(thisMonth, qa.id)).toEqual(
          daysBetween(qaLive, qaOff).filter((day) => day >= thisMonth.from && day <= thisMonth.to),
        );
        expect(daysWith(thisMonth, qa.id)).not.toContain(localDate(finished.startAt!, ZONE));
        expect(daysWith(followingMonth, qa.id)).toEqual([]);
        expect(daysWith(scheduledMonth, qa.id).every((day) => day <= qaOff)).toBe(true);

        // The scheduled window: exactly its days, from the schedule.
        const windowDays = daysBetween(localDate(windowStart, ZONE), localDate(windowEnd, ZONE));
        expect(daysWith(scheduledMonth, scheduled.id)).toEqual(
          windowDays.filter((day) => day >= scheduledMonth.from && day <= scheduledMonth.to),
        );

        // And the manual sale now counts as running at the same time as Black Friday,
        // over every product they share. It was never in this list. The finished
        // campaign is not, though "until reverted" from its start it used to be.
        const pair = (a: string, b: string) =>
          scheduledMonth.overlaps.find(
            (overlap) => [overlap.a.id, overlap.b.id].includes(a) && [overlap.a.id, overlap.b.id].includes(b),
          );
        expect(pair(manualSale, scheduled.id)?.sharedVariants).toBe(variantGids.length);
        expect(pair(qa.id, scheduled.id)).toBeUndefined();
      },
    );
  });
});
