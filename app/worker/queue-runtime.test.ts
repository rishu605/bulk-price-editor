/**
 * Choosing a runtime, and surviving Redis being gone.
 *
 * The important case is the degraded one. Losing queue isolation is a performance
 * problem; refusing to revert a sale because a cache is down is a merchant-facing one,
 * so the fallback has to actually run the work rather than drop it.
 */


import { describe, expect, it, vi } from "vitest";

import { sourceOf } from "../lib/testing/source";
import { logger } from "../lib/logging/logger";

import {
  connectionFor,
  inlineRuntime,
  reportDepths,
  runnableAt,
  runtimeFor,
  snapshotQueues,
} from "./queue-runtime.server";
import type { JobRef, QueueName } from "./queues";

describe("running without Redis", () => {
  it("does the work rather than dropping it", async () => {
    const done: Array<[QueueName, JobRef]> = [];
    const runtime = inlineRuntime(async (name, ref) => {
      done.push([name, ref]);
    });

    await runtime.enqueue("execution", { shopId: "s1", runId: "r1" });

    expect(done).toEqual([["execution", { shopId: "s1", runId: "r1" }]]);
  });

  it("has finished by the time enqueue resolves", async () => {
    // Not a detail: the chaos suite asserts on results, and a runtime that promised to
    // do the work eventually would make every scenario racy.
    let finished = false;
    const runtime = inlineRuntime(async () => {
      await Promise.resolve();
      finished = true;
    });

    await runtime.enqueue("planning", { shopId: "s1" });

    expect(finished).toBe(true);
  });

  it("reports every queue as empty rather than omitting them", async () => {
    // A missing queue in the depth map reads as a broken exporter. Zero reads as calm.
    const depths = await inlineRuntime(async () => {}).depths();

    expect(Object.values(depths).every((depth) => depth === 0)).toBe(true);
    expect(Object.keys(depths).length).toBeGreaterThan(0);
  });

  it("gives a job that asks for another turn its turns before returning (#811)", async () => {
    // A shop's webhook drain answers "again" when it stopped with deliveries waiting. Inline
    // there is nobody else's turn to go behind, and the caller is promised the work is done.
    let turns = 0;
    const runtime = inlineRuntime(async () => (++turns < 3 ? "again" : undefined));

    await runtime.enqueue("webhooks", { shopId: "s1" });

    expect(turns).toBe(3);
  });

  it("propagates a handler failure to the caller", async () => {
    // Inline means inline. Swallowing here would make a failure invisible in exactly
    // the deployment that has no queue to inspect.
    const runtime = inlineRuntime(async () => {
      throw new Error("handler blew up");
    });

    await expect(runtime.enqueue("audit", { shopId: "s1" })).rejects.toThrow("handler blew up");
  });
});

describe("picking a runtime", () => {
  it("runs inline when there is no REDIS_URL", async () => {
    const seen: QueueName[] = [];
    const runtime = runtimeFor(async (name) => void seen.push(name), {} as NodeJS.ProcessEnv);

    await runtime.enqueue("webhooks", { shopId: "s1" });

    expect(seen).toEqual(["webhooks"]);
  });

  it("runs inline rather than throwing when REDIS_URL is malformed", async () => {
    // A typo in an environment variable must not stop prices being written. It is
    // logged loudly and the work still happens.
    const seen: QueueName[] = [];
    const runtime = runtimeFor(async (name) => void seen.push(name), {
      REDIS_URL: "not a url",
    } as NodeJS.ProcessEnv);

    await runtime.enqueue("sync", { shopId: "s1" });

    expect(seen).toEqual(["sync"]);
  });
});

describe("both ends of a job's life are traced", () => {
  /**
   * `span()` is a no-op when OTel is off, which it is in tests, so there is nothing to
   * observe at runtime — the check is over the source, the way `built-for-shopify`
   * checks that every webhook route authenticates.
   *
   * Execution has been spanned since it was written. Enqueue was only counted, so a
   * trace showed a job appearing from nowhere and taking however long it took, with no
   * record of when it was asked for. The interesting number in a backlog is the gap
   * between the two, and a counter cannot express a gap.
   */
  const source = sourceOf(process.cwd(), "app/worker/queue-runtime.server.ts");

  it("spans the enqueue as well as the run", () => {
    expect(source, "the enqueue is not spanned").toMatch(/span\(\s*`enqueue \$\{name\}`/);
    expect(source, "the run is not spanned").toMatch(/span\(\s*`job \$\{name\}`/);
  });

  it("gives both spans the same attributes, so a trace lines them up", () => {
    for (const attribute of ['"queue.name"', '"shop.id"', '"campaign.id"', '"run.id"']) {
      const uses = source.split(attribute).length - 1;
      expect(uses, `${attribute} appears on only one of the two spans`).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("a job's log lines carry the ids the job was asked for", () => {
  /**
   * Before this, `job failed` was the only line in the tree with a `jobId` on it. The
   * handler output that would explain *why* it failed carried nothing to filter on, so
   * reconstructing a failed run meant ordering by timestamp and guessing.
   *
   * Asserted through `inlineRuntime` because that runs the real wrapper — the same
   * `traced()` the Redis worker goes through — rather than a copy of it.
   */
  async function lineFrom(ref: JobRef): Promise<Record<string, unknown>> {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubEnv("NODE_ENV", "production");
    try {
      const runtime = inlineRuntime(async () => {
        // A handler logging exactly as handlers do: no ids passed.
        logger.info("handling");
      });
      await runtime.enqueue("execution", ref);
      return JSON.parse(String(spy.mock.calls.at(-1)?.[0])) as Record<string, unknown>;
    } finally {
      vi.unstubAllEnvs();
      spy.mockRestore();
    }
  }

  it("binds the shop, campaign and run onto a line that passed none of them", async () => {
    const line = await lineFrom({ shopId: "s1", campaignId: "c1", runId: "r1" });

    expect(line).toMatchObject({
      message: "handling",
      shopId: "s1",
      campaignId: "c1",
      runId: "r1",
    });
  });

  it("omits the ids the job does not carry rather than binding them empty", async () => {
    const line = await lineFrom({ shopId: "s1" });

    expect(line.shopId).toBe("s1");
    expect(line.campaignId).toBeUndefined();
    expect(line.runId).toBeUndefined();
  });

  /**
   * The one id `inlineRuntime` cannot exercise: it exists only where BullMQ minted it,
   * so the check that the Redis worker hands it over is over the source. Comments are
   * stripped by `sourceOf`, so the note beside the call cannot satisfy this on its own.
   */
  it("queues a job's next turn when its handler asks for one (#811)", () => {
    const source = sourceOf("app/worker/queue-runtime.server.ts");

    expect(source, "the Redis worker ignores a handler asking for another turn").toMatch(
      /if \(result === "again"\) await add\(name, job\.data, \{ again: true \}\)/,
    );
    expect(source, "jobs are added without the per-job options a shop's drain needs").toMatch(
      /queue\.add\(name, ref, jobOptionsFor\(QUEUE_POLICIES\[name\], ref, \{ again \}\)\)/,
    );
  });

  it("hands the queue worker's job id to the same wrapper", () => {
    const source = sourceOf("app/worker/queue-runtime.server.ts");

    expect(
      source,
      "the Redis worker runs traced() without the BullMQ job id, so a queued job's log " +
        "lines cannot be filtered back to the job",
    ).toMatch(/traced\(name, job\.data, \(\) => handler\(name, job\.data\), job\.id\)/);
  });
});

describe("where the queues live (#813)", () => {
  it("keeps the URL's database index, which it used to drop", () => {
    // `/4` went to database 0 while the leader lock and the health check used 4, so a
    // reader of queue depth that honoured the index read a different database.
    expect(connectionFor("redis://localhost:6379/4")).toEqual({ host: "localhost", port: 6379, db: 4 });
  });

  it("leaves a production URL exactly as it was read before", () => {
    // Built, not written out: a URL with a password in it reads as a leaked credential to
    // the secret scanner, even an invented one.
    const production = new URL("redis://redis.railway.internal:6380");
    production.username = "default";
    production.password = "placeholder";
    expect(connectionFor(production.toString())).toEqual({
      host: "redis.railway.internal",
      port: 6380,
      password: "placeholder",
    });
    expect(connectionFor("redis://localhost")).toEqual({ host: "localhost", port: 6379 });
  });
});

describe("how far behind each queue is (#813)", () => {
  type FakeJob = { timestamp: number; data: Partial<JobRef> };

  /** A queue answering the two calls the snapshot makes, oldest waiting job first. */
  const fakeQueue = (counts: Record<string, number>, waiting: FakeJob[]) =>
    ({
      getJobCounts: async () => counts,
      getWaiting: async (start: number, end: number) => waiting.slice(start, end + 1),
    }) as never;

  it("does not count a delay the job asked for as waiting (#811)", async () => {
    // A shop's first drain is held five seconds to coalesce a product's burst; a retry
    // waits out its backoff. Neither is the queue being slow.
    expect(runnableAt({ timestamp: 1_000, delay: 5_000 })).toBe(6_000);
    expect(runnableAt({ timestamp: 1_000 })).toBe(1_000);

    const snapshots = await snapshotQueues((name) =>
      name === "webhooks"
        ? fakeQueue({ waiting: 1, active: 0, delayed: 0 }, [{ timestamp: 1_000, delay: 5_000, data: { shopId: "s" } } as never])
        : fakeQueue({ waiting: 0, active: 0, delayed: 0 }, []),
    );
    expect(snapshots.find((snapshot) => snapshot.queue === "webhooks")?.oldestWaitingAt).toBe(6_000);
  });

  it("reports the longest-waiting job, and for execution each shop's", async () => {
    const queues: Partial<Record<QueueName, unknown>> = {
      execution: fakeQueue({ waiting: 3, active: 2, delayed: 0 }, [
        { timestamp: 1_000, data: { shopId: "anchor-perf" } },
        { timestamp: 2_000, data: { shopId: "dartmode" } },
        { timestamp: 3_000, data: { shopId: "anchor-perf" } },
      ]),
    };
    const snapshots = await snapshotQueues(
      (name) => (queues[name] ?? fakeQueue({ waiting: 0, active: 0, delayed: 0 }, [])) as never,
    );
    const execution = snapshots.find((snapshot) => snapshot.queue === "execution")!;

    expect(execution).toMatchObject({ waiting: 3, active: 2, delayed: 0, oldestWaitingAt: 1_000 });
    expect(execution.oldestWaitingAtByShop).toEqual({ "anchor-perf": 1_000, dartmode: 2_000 });
    expect(snapshots.find((snapshot) => snapshot.queue === "sync")).toMatchObject({ oldestWaitingAt: null });
    // Every queue, so a missing one cannot read as calm.
    expect(snapshots).toHaveLength(6);
  });

  it("reports each queue's oldest wait as a metric beside its depth, zero when nothing waits", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubEnv("NODE_ENV", "production");
    try {
      const runtime = {
        ...inlineRuntime(async () => {}),
        snapshots: async () => [
          { queue: "execution" as const, waiting: 1, active: 0, delayed: 0, oldestWaitingAt: Date.now() - 90_000 },
          { queue: "sync" as const, waiting: 0, active: 0, delayed: 0, oldestWaitingAt: null },
        ],
      };
      await reportDepths(runtime);

      const lines = log.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);
      const ages = lines.filter((line) => line.metric === "queue.oldest_wait_ms");
      expect(ages.find((line) => line.queue === "execution")?.value).toBeGreaterThanOrEqual(90_000);
      expect(ages.find((line) => line.queue === "sync")?.value).toBe(0);
      expect(lines.filter((line) => line.metric === "queue.depth")).toHaveLength(6);
    } finally {
      vi.unstubAllEnvs();
      log.mockRestore();
    }
  });

  it("times each job's wait as it starts, per shop, first attempts only", () => {
    // Over the source, like the spans above: the wait is recorded inside BullMQ's own
    // worker callback, which only a real Redis exercises.
    const source = sourceOf("app/worker/queue-runtime.server.ts");
    expect(source).toMatch(/reportWait\(name, job\);\s*const result = await traced\(/);
    expect(source).toMatch(/metric\("queue\.wait_ms", Math\.max\(0, job\.processedOn - runnableAt\(job\)\)/);
    expect(source).toMatch(/if \(job\.attemptsMade > 0/);
  });
});
