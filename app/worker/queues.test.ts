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
  jobOptionsFor,
  QUEUE_NAMES,
  QUEUE_POLICIES,
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
