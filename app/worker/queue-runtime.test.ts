/**
 * Choosing a runtime, and surviving Redis being gone.
 *
 * The important case is the degraded one. Losing queue isolation is a performance
 * problem; refusing to revert a sale because a cache is down is a merchant-facing one,
 * so the fallback has to actually run the work rather than drop it.
 */

import { describe, expect, it } from "vitest";

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
