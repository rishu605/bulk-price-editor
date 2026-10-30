/**
 * The pool-wait metric: `db.pool_wait_ms`, per process (#810).
 *
 * #810's criterion is a percentile -- a page's database wait under 1 s p95 while a 102k run
 * writes -- so what is pinned is that every sample is emitted under the process it was
 * taken in, that a sample which failed after waiting still counts (it is the important one),
 * that the in-memory summary answers the same percentile, and that a starved pool is not
 * made worse by its own measurements piling up behind it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const emitted = vi.hoisted(() => [] as Array<{ name: string; value: number; labels: Record<string, unknown> }>);
vi.mock("../telemetry/metrics", () => ({
  metric: (name: string, value: number, labels: Record<string, unknown> = {}) => emitted.push({ name, value, labels }),
}));
vi.mock("../logging/logger", () => ({ logger: { debug() {}, info() {}, warn() {}, error() {} } }));

import { measurePoolWait, POOL_WAIT_WINDOW, recentPoolWait, resetPoolWaitForTests, startPoolWaitSampler } from "./pool-wait.server";

/** A client whose `SELECT 1` takes `ms` of fake time. */
const taking = (ms: number) => ({
  $queryRaw: (() => new Promise((resolve) => setTimeout(() => resolve([{ "?column?": 1 }]), ms))) as never,
});

beforeEach(() => {
  vi.useFakeTimers();
  emitted.length = 0;
  resetPoolWaitForTests();
  if (global.anchorPoolWaitSampler) clearInterval(global.anchorPoolWaitSampler);
  global.anchorPoolWaitSampler = undefined;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("measurePoolWait", () => {
  it("times the query and emits it as db.pool_wait_ms", async () => {
    const waited = measurePoolWait(taking(750));
    await vi.advanceTimersByTimeAsync(750);

    expect(await waited).toBe(750);
    expect(emitted).toEqual([{ name: "db.pool_wait_ms", value: 750, labels: { process: "web" } }]);
  });

  it("records a sample that failed after waiting, and still throws", async () => {
    // A P2024 after the whole pool timeout is the sample #803 was about. Dropping it because
    // the query failed would make a starved pool look healthy.
    const timedOut = {
      $queryRaw: (() =>
        new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error("pool"), { code: "P2024" })), 10_000))) as never,
    };
    const waited = measurePoolWait(timedOut).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(((await waited) as { code: string }).code).toBe("P2024");
    expect(emitted[0]!.value).toBe(10_000);
    expect(recentPoolWait().maxMs).toBe(10_000);
  });
});

describe("recentPoolWait", () => {
  it("answers nothing before the first sample, rather than zero", () => {
    expect(recentPoolWait()).toMatchObject({ samples: 0, p50Ms: null, p95Ms: null, maxMs: null, lastMs: null, lastAt: null });
  });

  it("gives the window's p50, p95 and max", async () => {
    for (let ms = 1; ms <= 20; ms++) {
      const waited = measurePoolWait(taking(ms * 10));
      await vi.advanceTimersByTimeAsync(ms * 10);
      await waited;
    }

    expect(recentPoolWait()).toMatchObject({ samples: 20, p50Ms: 100, p95Ms: 190, maxMs: 200, lastMs: 200 });
  });

  it("keeps only the recent window", async () => {
    for (let i = 0; i < POOL_WAIT_WINDOW + 5; i++) {
      const waited = measurePoolWait(taking(i < 5 ? 9_000 : 5));
      await vi.advanceTimersByTimeAsync(i < 5 ? 9_000 : 5);
      await waited;
    }

    expect(recentPoolWait()).toMatchObject({ samples: POOL_WAIT_WINDOW, maxMs: 5 });
  });
});

describe("the sampler", () => {
  it("labels every sample with the process that took it", async () => {
    startPoolWaitSampler(taking(3), "worker", 1_000);
    await vi.advanceTimersByTimeAsync(3_100);

    expect(emitted.map((sample) => sample.labels.process)).toEqual(["worker", "worker", "worker"]);
    expect(recentPoolWait().process).toBe("worker");
  });

  it("skips a tick while the last sample is still waiting", async () => {
    // Every 1 s against a pool that answers in 3.5 s: a sampler that did not skip would have
    // three queries queued behind each other, adding to the wait it is measuring.
    const queryRaw = vi.fn(() => new Promise((resolve) => setTimeout(resolve, 3_500)));
    startPoolWaitSampler({ $queryRaw: queryRaw as never }, "web", 1_000);
    await vi.advanceTimersByTimeAsync(4_600);

    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(emitted).toHaveLength(1);
  });

  it("starts once per process, however often the entry module is evaluated", async () => {
    const queryRaw = vi.fn(async () => []);
    startPoolWaitSampler({ $queryRaw: queryRaw as never }, "web", 1_000);
    startPoolWaitSampler({ $queryRaw: queryRaw as never }, "web", 1_000);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(queryRaw).toHaveBeenCalledTimes(1);
  });
});
