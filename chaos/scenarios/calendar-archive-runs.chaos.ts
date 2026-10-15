/**
 * The calendar leaves archived campaigns off, names what each run did, and puts an
 * overlap that is over in the past (#979).
 *
 * Three of #979's four failures were in what `calendarFor` hands the page:
 *
 * - **Archived campaigns appeared.** It read every campaign in the shop, so one the list
 *   had filed away was still on the calendar the list switches to.
 * - **Every run read "Applied".** The runs query took scoped runs -- a drift reassert, an
 *   auto-enrolment, one variant reverted -- and the grid called any non-REVERT an apply,
 *   so a reassert of one price read as the whole sale going live again.
 * - **Past overlaps read as present.** Nothing said whether either campaign had finished.
 *
 * Driven through the real run path, so each scoped run carries the occurrence key the
 * engine gives it: `revertVariant` for the one-variant revert, and `runCampaign` called
 * exactly as the drift reassert and the scheduler's enrolment call it.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import type { RunAction } from "../../app/lib/scheduling/calendar";
import { calendarFor, todayIn } from "../../app/services/calendar.server";
import { setArchived } from "../../app/services/campaigns/housekeeping.server";
import { createCampaign } from "../../app/services/campaigns/model.server";
import { runCampaign } from "../../app/services/campaigns/run.server";
import { revertVariant } from "../../app/services/campaigns/variant-revert.server";
import { chaosAdminClient } from "../harness/http-client";
import { withChaos } from "../harness/scenario";

describe("chaos: what the calendar shows and how it names it (#979)", () => {
  it("leaves archived campaigns off unless the archive is asked for, names each run for what it did, and puts a finished overlap in the past", async () => {
    await withChaos(
      "calendar-archive-runs",
      { catalog: { products: 4, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const { shopId, campaignId: sale, variantGids } = chaos.fixture;
        const client = chaosAdminClient(chaos.server.endpoint());
        const run = { actor: "chaos", verifySampleRate: 1 };
        const template = {
          compareAtPolicy: { kind: "leave" as const },
          rounding: { default: "none", byCurrency: {} },
          ast: { groups: [{ conditions: [{ field: "tag", value: "chaos" }] }] },
        };

        // The sale, applied whole: the one run here that is an apply of the campaign.
        await chaos.expectHonest((await chaos.apply()).runId);

        // Three scoped runs on the same campaign, each started the way its own path does.
        await revertVariant(shopId, sale, variantGids[0], client, { actor: "chaos" });
        await runCampaign(shopId, sale, client, {
          ...run,
          variantGids: [variantGids[1]],
          occurrenceKey: `VARIANT-REASSERT-${variantGids[1]}-${Date.now()}`,
        });
        await runCampaign(shopId, sale, client, {
          ...run,
          variantGids: [variantGids[2]],
          occurrenceKey: `VARIANT-ENROLL-${Date.now()}`,
        });

        // A weekend sale over the same products, applied and reverted while the sale is
        // up, so the two overlap and only one of them has finished.
        const weekend = await createCampaign(shopId, {
          ...template,
          name: "Weekend sale",
          priority: 950,
          rule: { kind: "percent-change", percent: -30 },
        } as never);
        await runCampaign(shopId, weekend.id, client, run);
        await runCampaign(shopId, weekend.id, client, { ...run, revert: true });

        // And one applied and then filed away. Archiving leaves it running.
        const filed = await createCampaign(shopId, {
          ...template,
          name: "Filed away",
          priority: 100,
          rule: { kind: "percent-change", percent: -10 },
        } as never);
        await runCampaign(shopId, filed.id, client, run);
        await setArchived(shopId, filed.id, true, "chaos");
        expect((await prisma.campaign.findUniqueOrThrow({ where: { id: filed.id } })).status).toBe("ACTIVE");

        const shop = await prisma.shop.findUniqueOrThrow({ where: { id: shopId } });
        const week = (archived?: boolean) =>
          calendarFor(shopId, shop.timezone, { view: "week", on: todayIn(shop.timezone), archived });

        const campaignsOn = (calendar: Awaited<ReturnType<typeof week>>) =>
          [...new Set(calendar.days.flatMap((day) => day.entries.map((entry) => entry.campaignId)))].sort();
        const runsOf = (calendar: Awaited<ReturnType<typeof week>>, campaignId?: string) =>
          calendar.days.flatMap((day) => day.runs).filter((r) => !campaignId || r.campaignId === campaignId);
        const actionsOf = (calendar: Awaited<ReturnType<typeof week>>, campaignId: string) =>
          runsOf(calendar, campaignId).map((r) => r.action).sort();

        // --- While the sale is still up ---
        const live = await week();

        // The archived campaign is nowhere: not as a bar, and not as a run on its day.
        expect(campaignsOn(live)).toEqual([sale, weekend.id].sort());
        expect(runsOf(live).filter((r) => r.campaignId === filed.id)).toEqual([]);
        expect(runsOf(live).length, "the other runs are still drawn, so the filter is not dropping everything").toBe(6);

        // Each run of the sale names what it did. One apply, not four.
        expect(actionsOf(live, sale)).toEqual(
          (["applied", "enrolled", "reasserted", "reverted-variant"] satisfies RunAction[]).sort(),
        );
        expect(actionsOf(live, weekend.id)).toEqual((["applied", "reverted"] satisfies RunAction[]).sort());
        // The one-variant revert is a REVERT run and still not drawn as the sale ending.
        const scopedRevert = runsOf(live, sale).find((r) => r.action === "reverted-variant")!;
        expect(scopedRevert.kind).toBe("REVERT");

        // One of the two has finished, so the overlap is not yet history.
        const overlapNow = live.overlaps.find((o) => [o.a.id, o.b.id].sort().join() === [sale, weekend.id].sort().join());
        expect(overlapNow, "the sale and the weekend sale overlap").toBeDefined();
        expect(overlapNow!.sharedVariants).toBeGreaterThan(0);
        const finishedNow = Object.fromEntries([overlapNow!.a, overlapNow!.b].map((side) => [side.id, side.finished]));
        expect(finishedNow).toEqual({ [sale]: false, [weekend.id]: true });

        // --- The archive, asked for ---
        const archive = await week(true);
        expect(campaignsOn(archive)).toEqual([filed.id]);
        expect(runsOf(archive).map((r) => [r.campaignId, r.action])).toEqual([[filed.id, "applied"]]);

        // --- After the sale ends ---
        await chaos.expectHonest((await chaos.revert()).runId);
        const over = await week();

        expect(actionsOf(over, sale)).toEqual(
          (["applied", "enrolled", "reasserted", "reverted", "reverted-variant"] satisfies RunAction[]).sort(),
        );
        const overlapThen = over.overlaps.find((o) => [o.a.id, o.b.id].sort().join() === [sale, weekend.id].sort().join());
        expect(overlapThen, "they still overlapped, in the past").toBeDefined();
        expect([overlapThen!.a.finished, overlapThen!.b.finished]).toEqual([true, true]);
      },
    );
  });
});
