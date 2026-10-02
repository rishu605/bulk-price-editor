/**
 * `/healthz` answering "is the worker running?" from outside.
 *
 * The worker is a separate service, so a healthy web process says nothing about whether
 * anything is ticking. Until this was reported, the only way to find out was a database
 * query — which is the wrong shape for the one condition that detects a dead worker.
 * `scheduler-stopped` is detected by *absence*, and absence needs an external reader.
 *
 * The two failure modes to keep apart are "never started" and "stopped". On a fresh
 * deployment the first is expected and the second is an incident, and a check that
 * reported them identically would cry wolf on every first boot.
 *
 * And it must never fail the check. Taking the web service down because a *different*
 * service stopped turns "scheduled reverts are late" into "the app is gone" — Railway
 * holds a deploy at "deploying" until this answers, so a 503 here would also stop a fixed
 * release from ever replacing a broken one.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { loader } from "../../app/routes/healthz";
import { TICK_SILENCE_SECONDS } from "../../app/lib/observability/alerts";
import { beat } from "../../app/services/scheduler-heartbeat.server";
import { withChaos } from "../harness/scenario";

type Health = {
  status: string;
  database: { ok: boolean; waitMs?: number; detail?: string };
  mail: { ok: boolean; detail?: string };
  scheduler: { ok: boolean; detail?: string; secondsSinceTick: number | null };
};

async function health(): Promise<{ body: Health; status: number }> {
  const response = await loader();
  return { body: (await response.json()) as Health, status: response.status };
}

describe("chaos: healthz reports the scheduler", () => {
  // Mail configured, so "ok" here means the scheduler and nothing else. Without it the
  // status reads "degraded" for mail's sake (#758), covered on its own below.
  beforeEach(() => {
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubEnv("NOTIFICATION_FROM_EMAIL", "anchor@example.com");
    vi.stubEnv("SUPPORT_EMAIL", "support@example.com");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("tells a worker that never started from one that stopped", async () => {
    await withChaos(
      "healthz-scheduler",
      { catalog: { products: 1, variantsPerProduct: 1 }, percent: -10 },
      async () => {
        // Never started.
        await prisma.schedulerHeartbeat.deleteMany({});

        const fresh = await health();
        expect(fresh.body.scheduler.ok).toBe(false);
        expect(fresh.body.scheduler.secondsSinceTick).toBeNull();
        expect(fresh.body.scheduler.detail, "a fresh deploy must say so").toMatch(/never/i);
        expect(fresh.status, "a missing worker must not fail the web healthcheck").toBe(200);

        // Running.
        await beat(new Date());
        const running = await health();
        expect(running.body.scheduler.ok).toBe(true);
        expect(running.body.scheduler.secondsSinceTick).toBeLessThanOrEqual(TICK_SILENCE_SECONDS);
        expect(running.body.status).toBe("ok");

        // Stopped: beaten once, then silent for longer than the threshold.
        await beat(new Date(Date.now() - (TICK_SILENCE_SECONDS + 60) * 1_000));
        const stopped = await health();
        expect(stopped.body.scheduler.ok).toBe(false);
        expect(stopped.body.scheduler.detail, "a stopped worker says how long").toMatch(/quiet for/);
        expect(stopped.body.status, "degraded, because the database is still fine").toBe("degraded");
        expect(
          stopped.status,
          "a stopped worker must never take the web service down with it",
        ).toBe(200);
      },
    );
  });

  it("reports a deployment that cannot send mail, without failing the check (#758)", async () => {
    await withChaos(
      "healthz-mail",
      { catalog: { products: 1, variantsPerProduct: 1 }, percent: -10 },
      async () => {
        await beat(new Date());
        expect((await health()).body.mail.ok).toBe(true);

        // Contact support cannot send, so merchants are shown the address instead: a
        // deployment missing a required variable, said at every deploy check -- and never
        // a 503, which would take away the pages that show the address.
        vi.stubEnv("SUPPORT_EMAIL", "");
        const missing = await health();
        expect(missing.body.mail.ok).toBe(false);
        expect(missing.body.mail.detail).toContain("SUPPORT_EMAIL");
        expect(missing.body.status).toBe("degraded");
        expect(missing.status).toBe(200);
      },
    );
  });

  it("reads degraded, not ok, while pages wait seconds for a connection (#803)", async () => {
    await withChaos(
      "healthz-pool",
      { catalog: { products: 1, variantsPerProduct: 1 }, percent: -10 },
      async () => {
        await beat(new Date());
        const quick = await health();
        expect(quick.body.status).toBe("ok");
        expect(quick.body.database.waitMs).toBeLessThan(2_000);

        // A pool run dry: the query waits for a connection. 25 Sep measured 6.8 to 10.4 s
        // here, with "ok" in the body the whole time.
        const queryRaw = prisma.$queryRaw.bind(prisma);
        vi.spyOn(prisma, "$queryRaw").mockImplementation((async (...args: unknown[]) => {
          await new Promise((resolve) => setTimeout(resolve, 2_200));
          return (queryRaw as (...a: unknown[]) => unknown)(...args);
        }) as never);
        try {
          const slow = await health();
          expect(slow.body.status, "a starved pool read as healthy").toBe("degraded");
          expect(slow.body.database.ok, "slow is not down").toBe(true);
          expect(slow.body.database.waitMs).toBeGreaterThan(2_000);
          expect(slow.body.database.detail).toMatch(/pages are waiting for database connections/);
          // Never a 503: a deploy's health check would fail for load the release did not cause.
          expect(slow.status).toBe(200);
        } finally {
          vi.restoreAllMocks();
        }
      },
    );
  });
});
