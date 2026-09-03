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

import { inlineRuntime, runtimeFor } from "./queue-runtime.server";
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
  it("hands the queue worker's job id to the same wrapper", () => {
    const source = sourceOf("app/worker/queue-runtime.server.ts");

    expect(
      source,
      "the Redis worker runs traced() without the BullMQ job id, so a queued job's log " +
        "lines cannot be filtered back to the job",
    ).toMatch(/traced\(name, job\.data, \(\) => handler\(name, job\.data\), job\.id\)/);
  });
});
