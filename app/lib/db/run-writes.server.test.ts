/**
 * A run's writes: bounded, sequential, and retried only when the database said "not now".
 *
 * #803's 102k run failed its own writes with P2024 and ended Partial over prices that had
 * landed (#802). The properties worth pinning are the ones that make a retry safe rather
 * than merely persistent: only the two codes that mean "this did not commit" are retried,
 * a retry gives up after a bounded number of tries with the original error, nothing else
 * is ever retried -- a constraint violation retried is the same violation, slower -- and no
 * statement ever carries more than `RUN_CHUNK` rows.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const recorded = vi.hoisted(() => [] as Array<{ name: string; labels: Record<string, unknown> }>);
vi.mock("../telemetry/metrics", () => ({
  metric: (name: string, _value: number, labels: Record<string, unknown> = {}) => recorded.push({ name, labels }),
}));

import { BIND_VARIABLE_CEILING } from "./chunk";
import { inRunChunks, isTransientDbError, retryTransient, RETRY_DELAYS_MS, RUN_CHUNK } from "./run-writes.server";

const prismaError = (code: string) => Object.assign(new Error(`prisma ${code}`), { code });
const noWait = { sleep: async () => {} };

beforeEach(() => {
  recorded.length = 0;
});

describe("which errors are transient", () => {
  it.each(["P2024", "P2034"])("%s is", (code) => {
    expect(isTransientDbError(prismaError(code))).toBe(true);
  });

  it.each(["P2002", "P2025", "P2010", "P1001", "ECONNREFUSED"])("%s is not", (code) => {
    // P2002 is the data being wrong; P1001 is the database being gone, which a five-second
    // pause does not fix and the run's own catch already reports for what it is.
    expect(isTransientDbError(prismaError(code))).toBe(false);
  });

  it("is not fooled by a message that merely mentions a pool", () => {
    expect(isTransientDbError(new Error("Timed out fetching a new connection from the connection pool"))).toBe(false);
  });
});

describe("retryTransient", () => {
  it("retries a P2024 and returns what the next attempt does", async () => {
    let calls = 0;
    const result = await retryTransient(
      "ledger.test",
      async () => {
        calls++;
        if (calls === 1) throw prismaError("P2024");
        return "written";
      },
      noWait,
    );

    expect(result).toBe("written");
    expect(calls).toBe(2);
    expect(recorded).toEqual([{ name: "db.transient_retries", labels: { what: "ledger.test", code: "P2024", outcome: "retried" } }]);
  });

  it("retries a P2034 the same way", async () => {
    let calls = 0;
    await retryTransient("ledger.test", async () => {
      if (++calls < 3) throw prismaError("P2034");
    }, noWait);

    expect(calls).toBe(3);
  });

  it("waits the backoff between attempts, longer each time", async () => {
    const waited: number[] = [];
    await retryTransient(
      "ledger.test",
      (() => {
        let calls = 0;
        return async () => {
          if (++calls <= RETRY_DELAYS_MS.length) throw prismaError("P2024");
        };
      })(),
      { sleep: async (ms) => void waited.push(ms) },
    );

    expect(waited).toEqual([...RETRY_DELAYS_MS]);
    expect([...waited].sort((a, b) => a - b)).toEqual(waited);
  });

  it("gives up after its retries with the original error, for the run's catch to handle", async () => {
    // The run's catch is what makes a run that cannot finish Partial with what landed
    // (#802). It must see the database's own error, code and all, not a wrapper.
    const original = prismaError("P2024");
    let calls = 0;
    const thrown = await retryTransient("ledger.test", async () => {
      calls++;
      throw original;
    }, noWait).catch((error: unknown) => error);

    expect(thrown).toBe(original);
    expect(calls).toBe(RETRY_DELAYS_MS.length + 1);
    expect(recorded.at(-1)).toEqual({ name: "db.transient_retries", labels: { what: "ledger.test", code: "P2024", outcome: "gave_up" } });
  });

  it.each([
    ["a constraint violation", prismaError("P2002")],
    ["a lost database", prismaError("P1001")],
    ["a statement timeout", prismaError("P2010")],
    ["anything else", new TypeError("boom")],
  ])("never retries %s", async (_name, error) => {
    let calls = 0;
    const thrown = await retryTransient("ledger.test", async () => {
      calls++;
      throw error;
    }, noWait).catch((caught: unknown) => caught);

    expect(thrown).toBe(error);
    expect(calls).toBe(1);
    expect(recorded).toEqual([]);
  });

  it("retries a statement that throws before it returns a promise", async () => {
    // How a mocked client throws, and how a Prisma call can fail while building its query.
    let calls = 0;
    await retryTransient("ledger.test", () => {
      if (++calls === 1) throw prismaError("P2024");
      return Promise.resolve();
    }, noWait);

    expect(calls).toBe(2);
  });
});

describe("inRunChunks", () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `gid://v/${i}`);

  it("never sends a batch bigger than RUN_CHUNK, over a 102,132-variant catalogue", async () => {
    const sizes: number[] = [];
    await inRunChunks("ledger.test", ids(102_132), async (batch) => void sizes.push(batch.length));

    expect(Math.max(...sizes)).toBe(RUN_CHUNK);
    expect(sizes).toHaveLength(Math.ceil(102_132 / RUN_CHUNK));
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(102_132);
  });

  it("leaves a full batch far under the bind ceiling, whatever the where clause adds", () => {
    expect(RUN_CHUNK).toBeLessThan(BIND_VARIABLE_CEILING / 10);
  });

  it("writes one batch at a time, never two at once", async () => {
    let inFlight = 0;
    let most = 0;
    await inRunChunks("ledger.test", ids(5_500), async () => {
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
    });

    expect(most).toBe(1);
  });

  it("retries the batch that failed, and only that one", async () => {
    const sent: string[] = [];
    let failedOnce = false;
    await inRunChunks(
      "ledger.test",
      ids(2_500),
      async (batch) => {
        if (batch[0] === "gid://v/1000" && !failedOnce) {
          failedOnce = true;
          throw prismaError("P2024");
        }
        sent.push(batch[0]!);
      },
      noWait,
    );

    expect(sent).toEqual(["gid://v/0", "gid://v/1000", "gid://v/2000"]);
  });

  it("stops at a batch that outlasts its retries, leaving the ones after it unsent", async () => {
    const sent: string[] = [];
    const thrown = await inRunChunks(
      "ledger.test",
      ids(3_000),
      async (batch) => {
        if (batch[0] === "gid://v/1000") throw prismaError("P2024");
        sent.push(batch[0]!);
      },
      noWait,
    ).catch((error: unknown) => error);

    expect((thrown as { code: string }).code).toBe("P2024");
    expect(sent).toEqual(["gid://v/0"]);
  });

  it("sums the counts updateMany reports", async () => {
    const result = await inRunChunks("ledger.test", ids(2_345), async (batch) => ({ count: batch.length }));

    expect(result.count).toBe(2_345);
  });

  it("sends nothing for nothing", async () => {
    const write = vi.fn();
    expect(await inRunChunks("ledger.test", [], write)).toEqual({ count: 0 });
    expect(write).not.toHaveBeenCalled();
  });
});
