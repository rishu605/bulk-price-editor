/**
 * `/healthz` and the alerting job see a run waiting behind another shop's (#813).
 *
 * The unit tests stand in for Redis; this puts a real job on a real BullMQ queue and reads
 * it back the way production does, because the part most likely to be wrong is the part a
 * stand-in agrees with: which end of the list BullMQ calls the front, whether a connection
 * handed to a `Queue` survives it closing, and which Redis database the reader is looking at
 * -- the runtime used to drop the URL's index, so a reader that honoured it read a database
 * the jobs were never in.
 *
 * The job is stamped five minutes old, which is what one shop's 1-variant apply looks like
 * behind another's 102,132-variant run when the worker is fair to nobody. Nothing in this
 * process consumes the queue, and the job is removed afterwards.
 */

import { Queue } from "bullmq";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loader } from "../../app/routes/healthz";
import { evaluate } from "../../app/lib/observability/alerts";
import { gather } from "../../app/services/alerting.server";
import { beat } from "../../app/services/scheduler-heartbeat.server";
import { connectionFor } from "../../app/worker/queue-runtime.server";
import { withChaos } from "../harness/scenario";

const REDIS_URL = process.env.REDIS_URL;

type Health = {
  status: string;
  degradedBy?: string[];
  queues: { ok: boolean; detail?: string; byQueue?: Record<string, { depth: number; oldestWaitMs: number | null }> };
};

describe.skipIf(!REDIS_URL)("chaos: a run waiting behind another shop's", () => {
  let queue: Queue | null = null;

  beforeEach(() => {
    // Mail configured, so "degraded" below is the queue and nothing else.
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubEnv("NOTIFICATION_FROM_EMAIL", "anchor@example.com");
    vi.stubEnv("SUPPORT_EMAIL", "support@example.com");
    // No web process to ask; the database-wait signal is another scenario's.
    vi.stubEnv("SHOPIFY_APP_URL", "");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (queue) {
      await queue.obliterate({ force: true }).catch(() => {});
      await queue.close();
      queue = null;
    }
  });

  it("reads degraded, still a 200, and pages for the shop that is waiting", async () => {
    await withChaos(
      "healthz-queues",
      { catalog: { products: 1, variantsPerProduct: 1 }, percent: -10 },
      async ({ fixture }) => {
        await beat(new Date());
        // The same parse the worker and the web process enqueue through.
        queue = new Queue("execution", { connection: { ...connectionFor(REDIS_URL!), maxRetriesPerRequest: null } });
        await queue.obliterate({ force: true }).catch(() => {});

        const calm = (await (await loader()).json()) as Health;
        expect(calm.queues.ok, calm.queues.detail).toBe(true);
        expect(calm.queues.byQueue?.execution).toEqual({ depth: 0, oldestWaitMs: null });

        const enqueuedAt = Date.now() - 5 * 60_000;
        await queue.add("execution", { shopId: fixture.shopId, campaignId: "waiting" }, { timestamp: enqueuedAt });
        // A newer job from another shop, behind it: the front is still the old one.
        await queue.add("execution", { shopId: "another-shop", campaignId: "behind" });

        const response = await loader();
        const behind = (await response.json()) as Health;
        expect(behind.status).toBe("degraded");
        expect(behind.degradedBy).toContain("queues");
        expect(behind.queues.byQueue?.execution.depth).toBe(2);
        expect(behind.queues.byQueue?.execution.oldestWaitMs).toBeGreaterThanOrEqual(5 * 60_000);
        expect(behind.queues.detail).toMatch(/execution: a job has waited \d+ s to start/);
        expect(response.status, "a backlog must never fail a deploy's health check").toBe(200);
        expect(JSON.stringify(behind), "an unauthenticated endpoint named a shop").not.toContain(fixture.shopId);

        const window = await gather();
        expect(window.executionQueueDepth).toBe(2);
        const waiting = window.shopRunWaits?.find((shop) => shop.shopId === fixture.shopId);
        expect(waiting?.waitMs).toBeGreaterThanOrEqual(5 * 60_000);
        expect(evaluate(window).map((alert) => alert.id)).toContain("shop-run-waiting");
      },
    );
  });
});
