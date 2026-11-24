/**
 * The job classes and their policies.
 *
 * These numbers decide whether a slow bulk import can delay a scheduled revert, which is
 * the one thing that must never wait. Worth asserting rather than leaving as constants
 * somebody adjusts without reading the reasoning above them.
 */

import { describe, expect, it } from "vitest";

import {
  deferWhileExecuting,
  isJobTurn,
  isRunLane,
  jobDedupKey,
  jobOptionsFor,
  laneFor,
  QUEUE_NAMES,
  QUEUE_POLICIES,
  RUN_LANES,
  SHOP_BUSY_RETRY_MS,
  WEBHOOK_COALESCE_MS,
  webhookDrainKey,
} from "./queues";

describe("the job classes", () => {
  it("has a policy for every queue", () => {
    for (const name of QUEUE_NAMES) {
      expect(QUEUE_POLICIES[name]?.name).toBe(name);
    }
  });

  it("keeps sync to one job at a time", () => {
    // A sync streams a whole catalogue into the database. Not for Shopify's sake: it runs
    // five bulk queries per app and shop at once from API 2026-01 (#1081), and a second
    // catalogue import of one shop is refused by the import itself.
    expect(QUEUE_POLICIES.sync.concurrency).toBe(1);
  });

  it("keeps the API-spending classes narrower than the database-bound ones", () => {
    // Two concurrent executions on one shop each see the other's throttle and back off,
    // turning one slow run into two slower ones.
    expect(QUEUE_POLICIES.execution.concurrency).toBeLessThan(
      QUEUE_POLICIES.webhooks.concurrency,
    );
    expect(QUEUE_POLICIES.verification.concurrency).toBeLessThan(
      QUEUE_POLICIES.planning.concurrency,
    );
  });

  it("never retries an execution job", () => {
    // Not an oversight. A partly-written run resumes through the ledger, which knows
    // which rows settled; retrying the whole job would replan from scratch and could
    // double-apply. Row-level retry is the right mechanism and it already exists.
    expect(QUEUE_POLICIES.execution.retryable).toBe(false);
    expect(QUEUE_POLICIES.execution.attempts).toBe(1);
  });

  it("retries the classes where a retry is safe", () => {
    for (const name of ["webhooks", "planning", "verification", "sync", "audit"] as const) {
      expect(QUEUE_POLICIES[name].attempts).toBeGreaterThan(1);
    }
  });

  it("backs off fastest on webhooks and slowest on audit", () => {
    // A webhook backlog should drain; a failing nightly audit should not hammer.
    expect(QUEUE_POLICIES.webhooks.backoffMs).toBeLessThan(QUEUE_POLICIES.audit.backoffMs);
  });
});

describe("job options", () => {
  it("gives a retryable class exponential backoff", () => {
    const options = jobOptionsFor(QUEUE_POLICIES.webhooks);

    expect(options.attempts).toBe(5);
    expect(options).toMatchObject({ backoff: { type: "exponential", delay: 1000 } });
  });

  it("gives a single-attempt class no backoff at all", () => {
    // A backoff on a job that never retries is dead configuration that reads as though
    // retries happen.
    expect(jobOptionsFor(QUEUE_POLICIES.execution)).not.toHaveProperty("backoff");
  });

  it("keeps failures around longer than successes", () => {
    // "What happened last night" needs something to look at beyond a log line.
    const options = jobOptionsFor(QUEUE_POLICIES.planning);

    expect(options.removeOnComplete).toMatchObject({ count: expect.any(Number) });
    expect(options.removeOnFail).toMatchObject({ age: expect.any(Number) });
  });
});

describe("a webhooks job is a shop's drain (#811)", () => {
  it("is deduplicated on the shop, so a storm of deliveries is one job, never two at once", () => {
    // Open-source BullMQ's deduplication, not Pro's groups: one job waiting absorbs the
    // rest, and one running keeps the latest as its successor rather than dropping it.
    expect(jobOptionsFor(QUEUE_POLICIES.webhooks, { shopId: "s1" })).toMatchObject({
      deduplication: { id: webhookDrainKey("s1"), keepLastIfActive: true },
    });
    expect(webhookDrainKey("s1")).not.toBe(webhookDrainKey("s2"));
  });

  it("waits for a product's burst to land before draining, but not when it is asking for its next turn", () => {
    expect(jobOptionsFor(QUEUE_POLICIES.webhooks, { shopId: "s1" }).delay).toBe(WEBHOOK_COALESCE_MS);
    expect(jobOptionsFor(QUEUE_POLICIES.webhooks, { shopId: "s1" }, { again: true }).delay).toBe(0);
    expect(WEBHOOK_COALESCE_MS).toBeGreaterThan(0);
    // Seconds, not minutes: drift is detected after this.
    expect(WEBHOOK_COALESCE_MS).toBeLessThanOrEqual(10_000);
  });

  it("leaves every other class's jobs as they were", () => {
    for (const name of QUEUE_NAMES.filter((queue) => queue !== "webhooks")) {
      const options = jobOptionsFor(QUEUE_POLICIES[name], { shopId: "s1" });
      expect(options, `${name} jobs became deduplicated`).not.toHaveProperty("deduplication");
      expect(options).not.toHaveProperty("delay");
    }
  });
});

describe("a job whose work is a row the tick rings again is never two jobs at once (#808)", () => {
  it("shares a key with its own duplicates, and with nothing else's", () => {
    expect(jobDedupKey("execution", { shopId: "s1", campaignId: "c1", runId: "r1" })).toBe("run:r1");
    expect(jobDedupKey("execution", { shopId: "s1", campaignId: "c1", runId: "r2" })).toBe("run:r2");
    expect(jobDedupKey("execution", { shopId: "s1", enroll: "c1" })).toBe("enroll:c1");
    expect(jobDedupKey("sync", { shopId: "s1", fullSync: true })).toBe("sync:s1");
    expect(jobDedupKey("sync", { shopId: "s1", recaptureId: "x1" })).toBe("recapture:x1");
  });

  it("is deduplicated in BullMQ's simple mode: absorbed while it waits or runs, free once it has finished", () => {
    expect(jobOptionsFor(QUEUE_POLICIES.execution, { shopId: "s1", runId: "r1" })).toMatchObject({ deduplication: { id: "run:r1" } });
    const sync = jobOptionsFor(QUEUE_POLICIES.sync, { shopId: "s1", fullSync: true });
    expect(sync).toMatchObject({ deduplication: { id: "sync:s1" } });
    // Not "keep the last while active": a ring of a run already running has nothing to add.
    expect(sync.deduplication).not.toHaveProperty("keepLastIfActive");
  });

  it("leaves a job the tick never rings as it was: a drift decision, a market sync, Flow's capture", () => {
    for (const [name, ref] of [
      ["execution", { shopId: "s1", campaignId: "c1", drift: { resolution: "adopt", asOf: "now" } }],
      ["execution", { shopId: "s1", campaignId: "c1", revert: true }],
      ["sync", { shopId: "s1" }],
      ["sync", { shopId: "s1", recaptureSegmentId: "seg" }],
    ] as const) {
      expect(jobDedupKey(name, ref as never), JSON.stringify(ref)).toBeNull();
    }
  });
});

describe("an enrolment job the release before this one cannot mistake for an apply (#808, #805)", () => {
  it("names its campaign in a field of its own, so that release's handler finds no campaign and does nothing", () => {
    // That release runs any execution job with a `campaignId` as a whole-campaign apply.
    const ref = { shopId: "s1", enroll: "c1" };
    expect(ref).not.toHaveProperty("campaignId");
    expect(jobDedupKey("execution", ref)).toBe("enroll:c1");
  });
});

describe("what waits while a shop is executing", () => {
  it("defers the classes that would spend the same budget for no urgency", () => {
    expect(deferWhileExecuting("audit")).toBe(true);
    expect(deferWhileExecuting("sync")).toBe(true);
  });

  it("never defers the classes a merchant is waiting on", () => {
    // A revert is planned and executed. Deferring either behind a bulk import is the
    // exact failure this whole topology exists to prevent.
    expect(deferWhileExecuting("planning")).toBe(false);
    expect(deferWhileExecuting("execution")).toBe(false);
    expect(deferWhileExecuting("verification")).toBe(false);
    expect(deferWhileExecuting("webhooks")).toBe(false);
  });
});

describe("the run lanes (#809)", () => {
  it("gives the small-run lane slots of its own, retried never, like execution", () => {
    expect(RUN_LANES).toEqual(["execution", "execution-small"]);
    expect(laneFor(true)).toBe("execution-small");
    expect(laneFor(false)).toBe("execution");
    for (const lane of RUN_LANES) {
      expect(isRunLane(lane)).toBe(true);
      // A partly-written run resumes through the ledger; a retried job would replan from scratch.
      expect(QUEUE_POLICIES[lane]).toMatchObject({ attempts: 1, retryable: false });
    }
    expect(isRunLane("sync")).toBe(false);
  });

  it("caps both lanes across every worker, at no more than one process runs", () => {
    // The database's budget, not a replica's CPU (#810): a second worker must not double it.
    for (const lane of RUN_LANES) {
      const policy = QUEUE_POLICIES[lane];
      expect(policy.globalConcurrency, lane).toBeGreaterThan(0);
      expect(policy.globalConcurrency!, lane).toBeLessThanOrEqual(policy.concurrency);
    }
    // Every other class keeps the per-process cap it had.
    for (const name of QUEUE_NAMES.filter((queue) => !isRunLane(queue))) {
      expect(QUEUE_POLICIES[name].globalConcurrency, name).toBeUndefined();
    }
  });

  it("deduplicates a run, an enrolment and a scheduled transition alike on either lane", () => {
    for (const lane of RUN_LANES) {
      expect(jobDedupKey(lane, { shopId: "s1", runId: "r1" })).toBe("run:r1");
      expect(jobDedupKey(lane, { shopId: "s1", enroll: "c1" })).toBe("enroll:c1");
      expect(jobDedupKey(lane, { shopId: "s1", scheduled: "c1" })).toBe("scheduled:c1:apply");
      expect(jobDedupKey(lane, { shopId: "s1", scheduled: "c1", revert: true })).toBe("scheduled:c1:revert");
    }
  });

  it("names a scheduled transition's campaign in a field of its own, so the release before cannot run it as an apply", () => {
    // That release runs any execution job with a `campaignId` as a whole-campaign apply.
    expect({ shopId: "s1", scheduled: "c1" }).not.toHaveProperty("campaignId");
  });

  it("puts a busy shop's job back for seconds, not minutes", () => {
    // How late a shop's second run starts after its first finishes.
    expect(SHOP_BUSY_RETRY_MS).toBeGreaterThan(0);
    expect(SHOP_BUSY_RETRY_MS).toBeLessThanOrEqual(10_000);
  });
});

describe("a chunked run's next turn (#809, D34)", () => {
  it("is the run's job, keyed as the run, so a ring of the run while it waits is absorbed", () => {
    const turn = { shopId: "s1", campaignId: "c1", runId: "r1", turn: true };
    expect(jobDedupKey("execution", turn)).toBe("run:r1");
  });

  it("is kept as the successor of the job asking for it, and goes behind whatever waits when that job ends", () => {
    const turn = jobOptionsFor(QUEUE_POLICIES.execution, { shopId: "s1", runId: "r1", turn: true }, { turn: true });
    expect(turn).toMatchObject({ deduplication: { id: "run:r1", keepLastIfActive: true } });
    expect(turn).not.toHaveProperty("delay");
    // Waiting on Shopify, it asks again after a poll's interval rather than at once.
    expect(jobOptionsFor(QUEUE_POLICIES.execution, { shopId: "s1", runId: "r1", turn: true }, { turn: true, delayMs: 5_000 })).toMatchObject({
      delay: 5_000,
    });
    // A ring is not a turn: it adds nothing while the run's job waits or runs.
    expect(jobOptionsFor(QUEUE_POLICIES.execution, { shopId: "s1", runId: "r1", turn: true }).deduplication).not.toHaveProperty(
      "keepLastIfActive",
    );
  });

  it("is told apart from every other answer a handler gives", () => {
    expect(isJobTurn({ turn: { shopId: "s1", runId: "r1", turn: true } })).toBe(true);
    for (const answer of [undefined, "again", "later"] as const) expect(isJobTurn(answer), String(answer)).toBe(false);
  });
});
