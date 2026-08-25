/**
 * A duplicate scheduler tick must not apply a campaign twice.
 *
 * `campaign_runs` carries a unique index on (campaign, occurrence, kind), documented as
 * exactly this guarantee. It was keyed on `${kind}-${Date.now()}` — the instant a run
 * started rather than the occurrence it was for — so two ticks two milliseconds apart
 * produced two keys and two runs, and the index fired only on an exact-millisecond
 * collision. The guarantee the schema claimed was, in practice, absent.
 *
 * The realistic trigger is a leader-lock gap: a Redis restart, a slow renewal, a deploy
 * overlap. Two workers each tick, each find the same window due, and each start a run
 * for one occurrence.
 *
 * Survivable even then, because campaign maths reads the baseline — that is what the
 * redis-restart scenario proves. This proves the layer that is supposed to stop it
 * happening at all.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { occurrenceKeyFor, parseSchedule } from "../../app/lib/scheduling/window";
import { withChaos } from "../harness/scenario";

describe("chaos: a duplicate scheduler tick", () => {
  it("produces one run for one window, however many ticks see it", async () => {
    await withChaos(
      "duplicate-tick",
      { catalog: { products: 4, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const { campaignId, variantGids, baseline } = chaos.fixture;

        // A window that opened an hour ago and has not closed.
        const startAt = new Date(Date.now() - 60 * 60_000);
        const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
        const schedule = {
          ...(campaign.schedule as object),
          kind: "window" as const,
          startAt: startAt.toISOString(),
        };
        await prisma.campaign.update({
          where: { id: campaignId },
          data: { status: "SCHEDULED", startAt, schedule: schedule as never },
        });

        // What two ticks, seconds apart, each compute for this window. The scheduler
        // itself needs a Shopify session the fixture shop does not have, so the key is
        // derived here exactly as `tick` derives it and handed to the same run path —
        // which is the part the guarantee actually rests on.
        const first = occurrenceKeyFor(parseSchedule(schedule), "apply", new Date());
        const second = occurrenceKeyFor(parseSchedule(schedule), "apply", new Date(Date.now() + 2_000));
        expect(second).toBe(first);
        expect(first).toBe(`APPLY@${startAt.toISOString()}`);

        const applied = await chaos.apply({ occurrenceKey: first });
        await chaos.expectHonest(applied.runId);
        expect(applied.verified).toBe(variantGids.length);

        // The second tick. It must stand down rather than apply a second time.
        const duplicate = await chaos.apply({ occurrenceKey: second });
        expect(duplicate.deferredTo).toBe(applied.runId);
        expect(duplicate.verified).toBe(0);

        // One run for one occurrence.
        expect(
          await prisma.campaignRun.count({ where: { campaignId, occurrenceKey: first } }),
        ).toBe(1);

        // And the prices are where one application puts them — not compounded.
        for (const gid of variantGids) {
          const once = Math.round(baseline.get(gid)! * 0.8);
          expect(chaos.fake.priceOf(gid)).toBe((once / 100).toFixed(2));
        }
      },
    );
  });

  it("still lets a merchant apply, revert, and apply again by hand", async () => {
    await withChaos(
      "duplicate-tick-manual",
      { catalog: { products: 3, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        // Manual runs stay keyed on the instant, deliberately. Collapsing two
        // deliberate applies seconds apart would break the ordinary rhythm for no
        // safety gained — the merchant is watching the screen and the button disables
        // itself.
        const first = await chaos.apply();
        await chaos.expectHonest(first.runId);

        await chaos.revert();

        const again = await chaos.apply();
        await chaos.expectHonest(again.runId);

        expect(again.runId).not.toBe(first.runId);
        expect(again.verified).toBe(3);
      },
    );
  });
});
