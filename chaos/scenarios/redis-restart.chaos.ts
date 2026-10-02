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
 *   Two workers applying the same campaign at once must not compound. Since #793 the
 *   second never runs: one live whole-campaign run per campaign is a unique index. Behind
 *   that is the rule that campaign math reads the baseline and never the live price -- a
 *   relative edit against live values would have a second run discount the first run's
 *   output, landing the merchant at 0.8 x 0.8 -- which is why the rule is an
 *   architectural constraint rather than a preference.
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
          // because either one alone would be a thin promise: the occurrence key for the
          // same occurrence, the database for any other.

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
          expect(deferred[0].messages[0]).toMatch(/is still being applied by a run that started/i);

          const runsForOccurrence = await prisma.campaignRun.count({
            where: { campaignId: chaos.fixture.campaignId, occurrenceKey: shared },
          });
          expect(runsForOccurrence).toBe(1);
          await chaos.expectHonest(started[0].runId);

          // Layer 2 -- the database (#793). Two applies under *different* occurrences are
          // what the key cannot catch, and what a second tab or a Flow resend produces. Both
          // used to run, and baseline-relative math was all that kept the result at one
          // application rather than 0.8 x 0.8. Now only one whole-campaign run can be live,
          // so the second stands down to the first and nothing is written twice. The
          // math still holds behind it -- the resolver's idempotency property tests (I2)
          // prove that -- but it is no longer the last line.
          await chaos.revert();
          const writesBefore = chaos.fake.writeLog.length;

          const both = await Promise.all([
            chaos.apply({ occurrenceKey: `${shared}-a` }),
            chaos.apply({ occurrenceKey: `${shared}-b` }),
          ]);
          const ran = both.filter((run) => !run.deferredTo);
          expect(ran, "two whole-campaign runs wrote at once").toHaveLength(1);
          expect(both.find((run) => run.deferredTo)?.deferredTo).toBe(ran[0].runId);
          await chaos.expectHonest(ran[0].runId);
          expect(chaos.fake.writeLog.length - writesBefore, "a variant was written twice").toBe(
            chaos.fixture.variantGids.length,
          );

          // The claim. Asked for twice at once, every price sits exactly where one
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
