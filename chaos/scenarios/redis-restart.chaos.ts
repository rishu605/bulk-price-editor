/**
 * Redis restarting mid-run, and the split brain that follows.
 *
 * Redis holds one thing here: the scheduler's leader lock. When it restarts, the key
 * is gone, and for one TTL two workers can both believe they lead. Both then tick, and
 * both find the same campaign due.
 *
 * Two claims, and the second is the one the architecture actually rests on.
 *
 *   The deposed leader must find out. A worker that keeps renewing a lock it no longer
 *   holds is worse than one that crashes, because it stays confidently wrong.
 *
 *   Two workers applying the same campaign at once must not compound. This is the
 *   payoff for the rule that campaign math reads the baseline and never the live price
 *   -- a relative edit against live values would have the second run discount the
 *   first run's output, and the merchant would end up at 0.8 x 0.8. Reading the
 *   baseline makes a concurrent double-apply merely redundant instead of destructive,
 *   which is why the rule is an architectural constraint rather than a preference.
 */

import Redis from "ioredis";
import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { LeaderLock } from "../../app/worker/leader-lock";
import { withChaos } from "../harness/scenario";
import { TcpProxy, targetOf, through } from "../harness/tcp-proxy";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const KEY = "anchor:chaos:leader";

describe("chaos: Redis restarts mid-run", () => {
  it("deposes the old leader and the resulting double-apply does not compound", async () => {
    await withChaos(
      "redis-restart",
      { catalog: { products: 10, variantsPerProduct: 2 }, percent: -20 },
      async (chaos) => {
        const target = targetOf(REDIS_URL, 6379);
        const proxy = new TcpProxy(target.host, target.port);
        await proxy.start();

        const proxied = through(REDIS_URL, proxy);
        const redisA = new Redis(proxied, { maxRetriesPerRequest: 1, lazyConnect: true });
        const redisB = new Redis(proxied, { maxRetriesPerRequest: 1, lazyConnect: true });
        const direct = new Redis(REDIS_URL);

        try {
          await Promise.all([redisA.connect(), redisB.connect()]);
          await direct.del(KEY);

          const leaderA = new LeaderLock(redisA, KEY, 30_000);
          const leaderB = new LeaderLock(redisB, KEY, 30_000);

          expect(await leaderA.acquire()).toBe(true);
          expect(await leaderB.acquire()).toBe(false);

          // ------------------------------------------------------- the restart
          // Connections dropped and the key gone, which is what a restart of an
          // unpersisted Redis actually does.
          proxy.cut();
          await direct.del(KEY);
          proxy.restore();

          await Promise.all([redisA.connect().catch(() => {}), redisB.connect().catch(() => {})]);

          // B takes over, and A must discover it no longer leads rather than
          // continuing to renew a lock somebody else now holds.
          expect(await leaderB.acquire()).toBe(true);
          expect(await leaderA.renew()).toBe(false);

          // ------------------------------------------- both tick the same campaign
          //
          // Two layers protect against a double-apply here, and both are tested,
          // because either one alone would be a thin promise.

          // Layer 1 -- the occurrence key. Both workers decide the same occurrence is
          // due, so only one may start a run for it. The loser must stand down
          // cleanly; an earlier version let the unique-constraint violation escape as
          // a raw database error, which is a crash where the answer is "already
          // running".
          const shared = `APPLY-${chaos.seed}-split-brain`;
          const contended = await Promise.all([
            chaos.apply({ occurrenceKey: shared }),
            chaos.apply({ occurrenceKey: shared }),
          ]);

          const deferred = contended.filter((run) => run.deferredTo);
          const started = contended.filter((run) => !run.deferredTo);
          expect(started).toHaveLength(1);
          expect(deferred).toHaveLength(1);
          expect(deferred[0].messages[0]).toMatch(/already being applied/i);

          const runsForOccurrence = await prisma.campaignRun.count({
            where: { campaignId: chaos.fixture.campaignId, occurrenceKey: shared },
          });
          expect(runsForOccurrence).toBe(1);
          await chaos.expectHonest(started[0].runId);

          // Layer 2 -- baseline-relative math. Suppose the key had not saved us and
          // two applies genuinely both ran. Because every campaign computes from the
          // baseline rather than the live price, the second is redundant instead of
          // destructive. This is the payoff for that architectural rule: a relative
          // edit against live values would land the merchant at 0.8 x 0.8.
          await chaos.revert();
          const writesBefore = chaos.fake.writeLog.length;

          const [first, second] = await Promise.all([
            chaos.apply({ occurrenceKey: `${shared}-a` }),
            chaos.apply({ occurrenceKey: `${shared}-b` }),
          ]);

          await chaos.expectHonest(first.runId);
          await chaos.expectHonest(second.runId);

          // Both runs genuinely did the work, or this proves nothing about
          // concurrency -- if one had planned nothing because the other finished
          // first, it would be a single apply wearing a costume.
          expect(first.planned).toBeGreaterThan(0);
          expect(second.planned).toBeGreaterThan(0);
          expect(chaos.fake.writeLog.length - writesBefore).toBeGreaterThan(
            chaos.fixture.variantGids.length,
          );

          // The claim. Applied twice concurrently, every price sits exactly where one
          // application puts it.
          for (const variantGid of chaos.fixture.variantGids) {
            const once = Math.round(chaos.fixture.baseline.get(variantGid)! * 0.8);
            expect(chaos.fake.priceOf(variantGid)).toBe((once / 100).toFixed(2));
          }
        } finally {
          await direct.del(KEY).catch(() => {});
          await Promise.allSettled([redisA.quit(), redisB.quit(), direct.quit()]);
          await proxy.stop();
        }
      },
    );
  });
});
