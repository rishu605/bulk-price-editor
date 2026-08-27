/**
 * A quiet scheduler and a stopped one must not look the same.
 *
 * `scheduler-stopped` is the alert that catches a dead worker, and it is the only one
 * that can. Every other condition in the window is computed from work the worker
 * produces — webhook lag from processed deliveries, the error rate from a denominator of
 * those same deliveries — so a process that stops outright empties all of them and they
 * fall silent rather than fire.
 *
 * It was reading the newest `campaign_runs.heartbeatAt` and calling that "seconds since
 * tick". Those rows are stamped by campaign runs while they execute, which made the
 * signal wrong in both directions at once:
 *
 *   On an idle shop — the normal state, most of the time — the newest heartbeat is hours
 *   or days old, so a perfectly healthy scheduler was reported stopped. A page that fires
 *   every quiet night is a page that gets muted, and a muted page is not an alert.
 *
 *   And a scheduler that died while a long run was still stamping looked alive, which is
 *   the exact case the alert exists for.
 *
 * These run against real Postgres because the bug was in a query, and a mocked Prisma
 * would have agreed with whatever the query said.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { gather } from "../../app/services/alerting.server";
import { beat, secondsSinceBeat } from "../../app/services/scheduler-heartbeat.server";
import { evaluate, TICK_SILENCE_SECONDS } from "../../app/lib/observability/alerts";
import { withChaos } from "../harness/scenario";

const fired = (window: Awaited<ReturnType<typeof gather>>) =>
  evaluate(window).map((alert) => alert.id);

describe("chaos: the scheduler heartbeat", () => {
  it("separates a quiet scheduler from a stopped one", async () => {
    await withChaos(
      "scheduler-heartbeat",
      { catalog: { products: 2, variantsPerProduct: 1 }, percent: -10 },
      async () => {
        const now = new Date();

        // Nothing has beaten yet. "We have not looked" is not "it is dead", and a fresh
        // deployment must not page.
        await prisma.schedulerHeartbeat.deleteMany({});
        expect(await secondsSinceBeat(now)).toBeNull();
        expect(fired(await gather(now))).not.toContain("scheduler-stopped");

        // The bug, reproduced. A campaign run that stamped a heartbeat two days ago, and
        // a scheduler that beat a second ago: healthy, idle, and silent.
        await prisma.campaignRun.updateMany({
          data: { heartbeatAt: new Date(now.getTime() - 2 * 24 * 60 * 60_000) },
        });
        await beat(new Date(now.getTime() - 1_000));

        const quiet = await gather(now);
        expect(quiet.secondsSinceTick).toBeLessThan(TICK_SILENCE_SECONDS);
        expect(fired(quiet)).not.toContain("scheduler-stopped");

        // And the case it is for. The beat stops; the stale campaign heartbeat is still
        // sitting there and must not stand in for it.
        await beat(new Date(now.getTime() - (TICK_SILENCE_SECONDS + 60) * 1_000));

        const stopped = await gather(now);
        expect(stopped.secondsSinceTick).toBeGreaterThan(TICK_SILENCE_SECONDS);
        expect(fired(stopped)).toContain("scheduler-stopped");
      },
    );
  });

  it("keeps one row however often it beats", async () => {
    await withChaos(
      "scheduler-heartbeat-singleton",
      { catalog: { products: 1, variantsPerProduct: 1 }, percent: -10 },
      async () => {
        await prisma.schedulerHeartbeat.deleteMany({});

        for (let i = 0; i < 5; i++) await beat(new Date());

        // A heartbeat that accumulated a row per tick would be 2,880 rows a day and an
        // unbounded table, and `secondsSinceBeat` reads one id rather than a max().
        expect(await prisma.schedulerHeartbeat.count()).toBe(1);
        expect(await secondsSinceBeat(new Date())).toBeLessThan(60);
      },
    );
  });
});
