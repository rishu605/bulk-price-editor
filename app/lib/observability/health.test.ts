/**
 * The rules `/healthz` reads degraded by (#813).
 *
 * The tests that matter most are the two ends: that a starved pool or a stuck queue does
 * *not* read "ok" -- it did throughout #803 -- and that none of it ever becomes a 503,
 * because Railway refuses a deploy on anything but a 200 and every one of these is load the
 * previous release is carrying.
 */

import { describe, expect, it } from "vitest";

import { QUEUE_NAMES } from "../../worker/queues";
import {
  DATABASE_WAIT_DEGRADED_MS,
  QUEUE_LIMITS,
  databaseSlow,
  healthLimits,
  httpStatusFor,
  queueOverrides,
  queueProblems,
  readingOf,
  statusOf,
  waitedMs,
  type QueueSnapshot,
} from "./health";

const defaults = healthLimits({});

describe("the database wait", () => {
  it("is degraded past one second by default, and not at it", () => {
    expect(DATABASE_WAIT_DEGRADED_MS).toBe(1_000);
    expect(databaseSlow(1_001, defaults)).toBe(true);
    expect(databaseSlow(1_000, defaults)).toBe(false);
    expect(databaseSlow(3, defaults)).toBe(false);
  });

  it("reads the 25 Sep measurement as degraded, which it was not", () => {
    // 6.8 to 10.4 s, and the body said "ok" the whole time (#803).
    expect(databaseSlow(6_800, defaults)).toBe(true);
    expect(databaseSlow(10_400, defaults)).toBe(true);
  });

  it("takes its limit from the environment", () => {
    expect(databaseSlow(400, healthLimits({ HEALTH_DATABASE_WAIT_MS: "250" }))).toBe(true);
  });

  it("keeps the default for a value it cannot read, rather than failing the endpoint", () => {
    for (const bad of ["", "soon", "-5", "0", "NaN"]) {
      expect(healthLimits({ HEALTH_DATABASE_WAIT_MS: bad }).databaseWaitMs, bad).toBe(DATABASE_WAIT_DEGRADED_MS);
    }
  });
});

describe("queue limits", () => {
  it("has a limit, or a deliberate never, for every queue", () => {
    expect(Object.keys(QUEUE_LIMITS).sort()).toEqual([...QUEUE_NAMES].sort());
  });

  it("never degrades on the audit queue, which NOT_ALERTS calls the least urgent thing there is", () => {
    expect(QUEUE_LIMITS.audit).toEqual({ depth: null, waitMs: null });
    expect(queueProblems({ audit: { depth: 1_000_000, oldestWaitMs: 86_400_000 } }, defaults)).toEqual([]);
  });

  it("reads overrides as queue=n pairs and ignores the rest", () => {
    expect(queueOverrides("webhooks=10000, execution = 20,bogus=3,sync=abc,audit=0")).toEqual({
      webhooks: 10_000,
      execution: 20,
    });
    expect(queueOverrides(undefined)).toEqual({});

    const limits = healthLimits({ HEALTH_QUEUE_DEPTH: "execution=5", HEALTH_QUEUE_WAIT_MS: "webhooks=1000" });
    expect(limits.queues.execution).toEqual({ depth: 5, waitMs: QUEUE_LIMITS.execution.waitMs });
    expect(limits.queues.webhooks).toEqual({ depth: QUEUE_LIMITS.webhooks.depth, waitMs: 1_000 });
  });
});

describe("how far behind a queue is", () => {
  const snapshot = (over: Partial<QueueSnapshot>): QueueSnapshot => ({
    queue: "execution",
    waiting: 0,
    active: 0,
    delayed: 0,
    oldestWaitingAt: null,
    ...over,
  });

  it("counts depth the way queue.depth always has: waiting, running and delayed", () => {
    expect(readingOf(snapshot({ waiting: 3, active: 2, delayed: 1 }), 0).depth).toBe(6);
  });

  it("is degraded when the execution queue is deeper than its limit", () => {
    const limit = QUEUE_LIMITS.execution.depth!;
    const deep = readingOf(snapshot({ waiting: limit + 1 }), 0);

    expect(queueProblems({ execution: deep }, defaults)).toEqual([`execution: ${limit + 1} jobs deep (limit ${limit})`]);
    expect(queueProblems({ execution: readingOf(snapshot({ waiting: limit }), 0) }, defaults)).toEqual([]);
  });

  it("is degraded when the job at the front has waited too long to start, however shallow the queue", () => {
    // One job, two minutes: a merchant's apply behind another shop's run. Depth one is
    // nowhere near a limit, which is why depth alone could not say this.
    const now = 1_000_000;
    const stuck = readingOf(snapshot({ waiting: 1, oldestWaitingAt: now - 120_000 }), now);

    expect(stuck.oldestWaitMs).toBe(120_000);
    expect(queueProblems({ execution: stuck }, defaults)).toEqual([
      "execution: a job has waited 120 s to start (limit 60 s)",
    ]);
  });

  it("is not degraded by a busy queue that is moving", () => {
    // Every shop's drain queued at once after a deploy (#811): deep, the front job a second old.
    const now = 1_000_000;
    const busy = readingOf(snapshot({ queue: "webhooks", waiting: 150, oldestWaitingAt: now - 1_000 }), now);
    expect(queueProblems({ webhooks: busy }, defaults)).toEqual([]);
  });

  it("never reports a negative wait, whoever's clock stamped the job", () => {
    // Enqueued by the web process, read by another: a job "from the future" has waited
    // no time, not minus some.
    expect(waitedMs(2_000, 1_000)).toBe(0);
    expect(waitedMs(null, 1_000)).toBeNull();
    expect(readingOf(snapshot({ waiting: 1, oldestWaitingAt: 5_000 }), 4_000).oldestWaitMs).toBe(0);
  });

  it("says nothing waits when nothing does, rather than a wait of zero", () => {
    expect(readingOf(snapshot({ active: 2 }), 1_000).oldestWaitMs).toBeNull();
  });
});

describe("the status, and the code Railway sees", () => {
  it("is ok with nothing wrong, degraded with anything wrong, unhealthy only without a database", () => {
    expect(statusOf({ databaseAnswered: true, degradedBy: [] })).toBe("ok");
    expect(statusOf({ databaseAnswered: true, degradedBy: ["database"] })).toBe("degraded");
    expect(statusOf({ databaseAnswered: true, degradedBy: ["queues"] })).toBe("degraded");
    expect(statusOf({ databaseAnswered: false, degradedBy: [] })).toBe("unhealthy");
  });

  it("answers degraded with a 200, so load on the old release cannot refuse the new one", () => {
    // Railway holds a deploy until /healthz answers 200 and fails it otherwise. A new
    // container has a pool of its own; a 503 for a slow database or a deep queue would
    // keep a fix out because the release it replaces is busy.
    expect(httpStatusFor("ok")).toBe(200);
    expect(httpStatusFor("degraded")).toBe(200);
    expect(httpStatusFor("unhealthy")).toBe(503);
  });
});
