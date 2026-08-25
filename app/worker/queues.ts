/**
 * The job classes, and what each is allowed to do to a shop's rate-limit budget.
 *
 * Until now the worker was one tick loop that did everything in order. That works until
 * it does not: a four-hour bulk import on one shop blocks every other shop's scheduled
 * sale behind it, and a poison job blocks the loop rather than one queue. Separating the
 * classes means a slow import cannot delay a revert, which is the one thing that must
 * never wait.
 *
 * Concurrency is per class rather than global, and the numbers come from what each class
 * actually contends for:
 *
 *   `execution` and `verification` spend a shop's Admin API budget, so they are narrow.
 *   Two concurrent executions on the same shop would each see the other's throttle and
 *   back off, turning one slow run into two slower ones.
 *
 *   `webhooks` and `planning` are database-bound and cheap, so they are wide. A webhook
 *   backlog after a large catalogue edit should drain, not trickle.
 *
 *   `sync` is deliberately one: Shopify permits a single bulk operation per shop, and
 *   queueing more only discovers that later and less clearly.
 *
 * **Job data carries ids, never payloads.** A job holding a webhook body or a page of
 * variants is a second copy of state that can disagree with the database, and Redis is
 * the worst place to discover that. Every handler re-reads what it needs.
 */

export const QUEUE_NAMES = [
  "sync",
  "webhooks",
  "planning",
  "execution",
  "verification",
  "audit",
] as const;

export type QueueName = (typeof QUEUE_NAMES)[number];

export interface QueuePolicy {
  name: QueueName;
  concurrency: number;
  attempts: number;
  /** Milliseconds before the first retry; doubled each attempt. */
  backoffMs: number;
  /**
   * Whether a failure here should be retried at all.
   *
   * False for execution, and that is not an oversight: a partly-written run is resumed
   * deliberately through the ledger, which knows which rows settled. Blindly retrying
   * the job would replan from scratch and could double-apply. The run's own retry
   * policy (P2.6) is the right mechanism, and it is row-level.
   */
  retryable: boolean;
}

export const QUEUE_POLICIES: Record<QueueName, QueuePolicy> = {
  sync: { name: "sync", concurrency: 1, attempts: 3, backoffMs: 30_000, retryable: true },
  webhooks: { name: "webhooks", concurrency: 10, attempts: 5, backoffMs: 1_000, retryable: true },
  planning: { name: "planning", concurrency: 5, attempts: 3, backoffMs: 5_000, retryable: true },
  execution: { name: "execution", concurrency: 2, attempts: 1, backoffMs: 0, retryable: false },
  verification: {
    name: "verification",
    concurrency: 2,
    attempts: 3,
    backoffMs: 10_000,
    retryable: true,
  },
  audit: { name: "audit", concurrency: 1, attempts: 2, backoffMs: 60_000, retryable: true },
};

/** Everything a job needs to find its work. Ids only — see the note above. */
export interface JobRef {
  shopId: string;
  campaignId?: string;
  runId?: string;
  webhookEventId?: string;
  /** Set for a revert, so a handler can never confuse one with an apply. */
  revert?: boolean;
}

/**
 * BullMQ's options for a queue, derived from its policy.
 *
 * Kept as a function rather than a literal so the policy stays the single place the
 * numbers live, and a queue cannot quietly be given different retry behaviour from the
 * one documented above it.
 */
export function jobOptionsFor(policy: QueuePolicy) {
  return {
    attempts: policy.attempts,
    ...(policy.backoffMs > 0
      ? { backoff: { type: "exponential" as const, delay: policy.backoffMs } }
      : {}),
    // Completed jobs are dropped; failures are kept for a while so a merchant asking
    // "what happened last night" has something to look at beyond a log line.
    removeOnComplete: { count: 100 },
    removeOnFail: { age: 7 * 24 * 60 * 60 },
  };
}

/**
 * Whether a job class may run for a shop that is mid-execution.
 *
 * Verification and audit read the same budget an execution is spending. Letting them run
 * alongside turns one throttled shop into three, and the audit is the least urgent of
 * the three by a wide margin.
 */
export function deferWhileExecuting(name: QueueName): boolean {
  return name === "audit" || name === "sync";
}
