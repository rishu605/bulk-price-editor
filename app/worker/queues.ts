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
 *   backlog after a large catalogue edit should drain, not trickle. Wide across shops, not
 *   within one: a `webhooks` job drains one shop's deliveries, and there is at most one
 *   running per shop (#811) -- see `jobOptionsFor`.
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
  /**
   * The state the web process took the campaign out of when it claimed it and handed the
   * run here (#772), so a run that fails before it starts puts it back there.
   */
  claimedFrom?: string;
  /**
   * A baseline capture of this segment that Flow asked for and was too large to finish
   * inside Flow's ten seconds (#773). Carried on the sync queue.
   */
  recaptureSegmentId?: string;
  /**
   * A recapture the recapture page started whose wholesale prices need more quantity-ladder
   * reads than the page can wait on (#1105): its row, which holds the scope, the count the
   * merchant was shown and what they confirmed, and which the page follows. On the sync queue.
   */
  recaptureId?: string;
  /** A whole catalogue sync, started from Home and followed there (#801). On the sync queue. */
  fullSync?: boolean;
  /** An execution job that continues a partial run rather than starting fresh (#790). */
  resume?: boolean;
  /** Who asked, so what the run resolves on their behalf is attributed to them. */
  actor?: string;
  /** Variants the merchant asked to leave as they are, and why (#790). */
  skipVariantGids?: string[];
  skipReason?: string;
  /**
   * One decision over a filtered set of the campaign's drifted prices (#822), too many to
   * resolve while the page waits. The filters and the moment the merchant saw them, not
   * the events: the handler reads those again, as every handler does.
   */
  drift?: {
    resolution: "adopt" | "reassert" | "ignore";
    /** When the page that confirmed it was loaded; an edit after this is not in it. */
    asOf: string;
    q?: string;
    direction?: "up" | "down";
  };
}

/**
 * What a handler may answer besides finishing: `"again"` asks for another turn of the same
 * job, behind whatever else is waiting (#811). A shop's webhook drain says it when it
 * stopped with deliveries still waiting, so one shop's echo storm is drained a turn at a
 * time between other shops' turns rather than holding a slot until it is done.
 */
export type JobResult = void | "again";

/**
 * How long a shop's first waiting delivery waits for others before the worker drains them
 * (#811). A product written in several calls -- a variant page at a time, a market at a
 * time, its tags after its prices -- sends a webhook per call within seconds, and only the
 * newest of them needs handling. Under a backlog the wait is moot: everything queued for a
 * product when its turn comes is coalesced, however old.
 */
export const WEBHOOK_COALESCE_MS = 5_000;

/** The one key a shop's webhook jobs share, so there is never more than one per shop (#811). */
export function webhookDrainKey(shopId: string): string {
  return `webhooks:${shopId}`;
}

/**
 * BullMQ's options for a queue, derived from its policy.
 *
 * Kept as a function rather than a literal so the policy stays the single place the
 * numbers live, and a queue cannot quietly be given different retry behaviour from the
 * one documented above it.
 *
 * A `webhooks` job is a shop's drain, not a delivery (#811). Shopify can send thousands of
 * deliveries for one shop in a minute -- every price a large run writes echoes back -- and
 * a job per delivery put all of them ahead of the next shop's one merchant edit, ten at a
 * time on every slot the queue has. So the shop's deliveries wait in `webhook_events` and
 * the queue holds one job per shop, deduplicated on the shop's key. BullMQ's open-source
 * deduplication, not Pro's groups:
 *
 *   - A job waiting or delayed for the shop absorbs every later one: it will read the
 *     deliveries they were rung for.
 *   - One running stores the latest as its successor (`keepLastIfActive`), created when it
 *     finishes. So a delivery persisted while the drain is reading never waits for a
 *     drain that has already looked, and a shop never has two drains at once -- which is
 *     also what keeps one product's deliveries in order.
 *
 * The first is delayed by `WEBHOOK_COALESCE_MS`, so a burst for one product lands before
 * it is read. A drain asking for another turn (`again`) is not: its successor goes to the
 * back of the queue at once, behind the shops that were waiting.
 */
export function jobOptionsFor(policy: QueuePolicy, ref?: JobRef, { again = false }: { again?: boolean } = {}) {
  return {
    attempts: policy.attempts,
    ...(policy.backoffMs > 0
      ? { backoff: { type: "exponential" as const, delay: policy.backoffMs } }
      : {}),
    // Completed jobs are dropped; failures are kept for a while so a merchant asking
    // "what happened last night" has something to look at beyond a log line.
    removeOnComplete: { count: 100 },
    removeOnFail: { age: 7 * 24 * 60 * 60 },
    ...(policy.name === "webhooks" && ref
      ? {
          delay: again ? 0 : WEBHOOK_COALESCE_MS,
          deduplication: { id: webhookDrainKey(ref.shopId), keepLastIfActive: true },
        }
      : {}),
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
