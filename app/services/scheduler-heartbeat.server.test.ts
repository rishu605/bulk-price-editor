/**
 * The scheduler's age is never negative, however long the read waited (#813).
 *
 * `/healthz` asked "how long since the last beat" with a `now` taken before its query, and
 * on 25 Sep that query waited up to 10.4 s for a pooled connection. A beat the worker
 * stamped during the wait came out *after* `now`: a negative age, which reads as a
 * scheduler beating in the future to anyone comparing it with a threshold.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const read = vi.hoisted(() => ({ during: (): Date | null => null }));

vi.mock("../db.server", () => ({
  default: {
    schedulerHeartbeat: {
      // A pool wait: the clock moves on ten seconds before the row comes back, and the
      // worker beat eight seconds in.
      findUnique: async () => {
        const beatAt = read.during();
        return beatAt ? { beatAt } : null;
      },
    },
  },
}));

import { secondsBetween, secondsSinceBeat } from "./scheduler-heartbeat.server";

const T = Date.UTC(2026, 8, 25, 17, 49, 0);

afterEach(() => vi.useRealTimers());

describe("secondsSinceBeat under a slow query", () => {
  it("measures from after the read, so a beat stamped during the wait is seconds old, not negative", async () => {
    vi.useFakeTimers({ now: T });
    read.during = () => {
      vi.setSystemTime(T + 10_000);
      return new Date(T + 8_000);
    };

    // Taken before the query, as the default parameter used to be, this was 8 - 10 = -8.
    expect(await secondsSinceBeat()).toBe(2);
  });

  it("floors an explicit `now` from before the read at zero rather than going below it", async () => {
    read.during = () => new Date(T + 8_000);

    expect(await secondsSinceBeat(new Date(T))).toBe(0);
  });

  it("still says how long a stopped scheduler has been quiet", async () => {
    read.during = () => new Date(T - 600_000);

    expect(await secondsSinceBeat(new Date(T))).toBe(600);
  });

  it("still says it has never beaten, rather than inventing an age", async () => {
    read.during = () => null;

    expect(await secondsSinceBeat()).toBeNull();
  });
});

describe("secondsBetween", () => {
  it("rounds to whole seconds and never goes below zero", () => {
    expect(secondsBetween(new Date(T), new Date(T + 1_499))).toBe(1);
    expect(secondsBetween(new Date(T + 400), new Date(T))).toBe(0);
    expect(Object.is(secondsBetween(new Date(T + 400), new Date(T)), -0)).toBe(false);
    expect(secondsBetween(new Date(T + 90_000), new Date(T))).toBe(0);
  });
});
