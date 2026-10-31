/**
 * `/healthz` end to end, with the stores stood in for (#813).
 *
 * The chaos suite proves the slow-pool case against a real Postgres; this proves every way
 * the route can read degraded -- a slow `SELECT 1`, a deep queue, a job that has waited too
 * long -- in milliseconds, and that each of them is still a 200. It lives here rather than
 * beside the route because a file in `app/routes` is a route.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { QueueSnapshot } from "./health";

const stores = vi.hoisted(() => ({
  queryDelayMs: 0,
  queryFails: false,
  beatAt: new Date() as Date | null,
  redis: null as null | { ok: boolean; detail?: string; snapshots: unknown[] | null; queuesDetail?: string },
}));

vi.mock("../../db.server", () => ({
  default: {
    $queryRaw: async () => {
      await new Promise((resolve) => setTimeout(resolve, stores.queryDelayMs));
      if (stores.queryFails) throw new Error("Can't reach database server");
      return [{ "?column?": 1 }];
    },
    schedulerHeartbeat: {
      findUnique: async () => (stores.beatAt ? { beatAt: stores.beatAt } : null),
    },
  },
}));
vi.mock("../../worker/queue-stats.server", () => ({ probeRedis: async () => stores.redis }));
vi.mock("../../services/support.server", () => ({ supportEmailConfigured: () => true }));

const { loader } = await import("../../routes/healthz");

type Body = {
  status: string;
  degradedBy?: string[];
  database: { ok: boolean; waitMs: number; limitMs: number; detail?: string };
  queues: { ok: boolean; detail?: string; byQueue?: Record<string, { depth: number; oldestWaitMs: number | null }> };
};

async function health(): Promise<{ status: number; body: Body; text: string }> {
  const response = await loader();
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text) as Body, text };
}

const empty = (queue: string, over: Partial<QueueSnapshot> = {}): QueueSnapshot =>
  ({ queue, waiting: 0, active: 0, delayed: 0, oldestWaitingAt: null, ...over }) as QueueSnapshot;

const calmQueues = () =>
  ["sync", "webhooks", "planning", "execution", "verification", "audit"].map((queue) => empty(queue));

beforeEach(() => {
  stores.queryDelayMs = 0;
  stores.queryFails = false;
  stores.beatAt = new Date();
  stores.redis = { ok: true, snapshots: calmQueues() };
  // A threshold the test can cross in tens of milliseconds rather than a second.
  vi.stubEnv("HEALTH_DATABASE_WAIT_MS", "50");
});
afterEach(() => vi.unstubAllEnvs());

describe("/healthz reads what is waiting, not only what answered (#813)", () => {
  it("is ok when the database is quick and the queues are calm", async () => {
    const { status, body } = await health();
    expect(body.status).toBe("ok");
    expect(status).toBe(200);
    expect(body.database.limitMs).toBe(50);
    expect(body.queues.byQueue?.execution).toEqual({ depth: 0, oldestWaitMs: null });
  });

  it("reads degraded while SELECT 1 waits past the limit, and stays a 200", async () => {
    stores.queryDelayMs = 80;
    const { status, body } = await health();

    expect(body.status, "a starved pool read as healthy, as it did throughout #803").toBe("degraded");
    expect(body.degradedBy).toEqual(["database"]);
    expect(body.database.ok, "slow is not down").toBe(true);
    expect(body.database.waitMs).toBeGreaterThan(50);
    expect(body.database.detail).toMatch(/waiting for database connections/);
    expect(status, "Railway would refuse a deploy for load the new release did not cause").toBe(200);
  });

  it("reads degraded when the execution queue is deeper than its limit", async () => {
    stores.redis = {
      ok: true,
      snapshots: calmQueues().map((q) => (q.queue === "execution" ? { ...q, waiting: 40, active: 2, delayed: 9 } : q)),
    };
    const { status, body } = await health();

    expect(body.status).toBe("degraded");
    expect(body.degradedBy).toEqual(["queues"]);
    expect(body.queues.detail).toContain("execution: 51 jobs deep (limit 50)");
    expect(status).toBe(200);
  });

  it("reads degraded when a job has waited too long to start, in a queue only one deep", async () => {
    stores.redis = {
      ok: true,
      snapshots: calmQueues().map((q) =>
        q.queue === "execution"
          ? { ...q, waiting: 1, oldestWaitingAt: Date.now() - 5 * 60_000, oldestWaitingAtByShop: { "shop-a": Date.now() - 5 * 60_000 } }
          : q,
      ),
    };
    const { status, body, text } = await health();

    expect(body.status).toBe("degraded");
    expect(body.queues.detail).toMatch(/execution: a job has waited 3\d\d s to start/);
    expect(body.queues.byQueue?.execution.oldestWaitMs).toBeGreaterThanOrEqual(5 * 60_000);
    expect(status).toBe(200);
    // Unauthenticated: counts and ages per queue, never whose jobs they are.
    expect(text).not.toContain("shop-a");
  });

  it("does not count a Redis outage twice", async () => {
    stores.redis = { ok: false, detail: "connect ECONNREFUSED", snapshots: null, queuesDetail: "not read: Redis did not answer" };
    const { status, body } = await health();

    expect(body.status).toBe("degraded");
    expect(body.degradedBy).toEqual(["redis"]);
    expect(body.queues).toEqual({ ok: false, detail: "not read: Redis did not answer" });
    expect(status).toBe(200);
  });

  it("is a 503 only when the database does not answer at all", async () => {
    stores.queryFails = true;
    const { status, body } = await health();

    expect(body.status).toBe("unhealthy");
    expect(status).toBe(503);
  });
});
