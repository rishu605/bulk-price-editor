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
 *   back off, turning one slow run into two slower ones -- so a shop runs one at a time,
 *   held by its lease in Postgres rather than by the queue (#809, `shop-lease.server.ts`).
 *
 *   `execution-small` is the small-run lane (#809): a run the inline budget's own figures put
 *   at two minutes of writing or less. Slots of its own, so a merchant's one-variant revert
 *   never waits behind another shop's catalogue-wide sale, which can hold an `execution` slot
 *   for an hour. Both lanes are capped across every worker process, not per process: their
 *   numbers come from the worker's database pool (#810), which a second replica does not grow.
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
  "execution-small",
  "verification",
  "audit",
] as const;

export type QueueName = (typeof QUEUE_NAMES)[number];

export interface QueuePolicy {
  name: QueueName;
  /** Jobs one worker process runs at once. */
  concurrency: number;
  /**
   * Jobs every worker process together runs at once: BullMQ's global concurrency, set on the
   * queue when a worker starts (#809). For the classes whose cap is the database's budget
   * rather than the process's CPU, which a second replica would otherwise double (#810).
   */
  globalConcurrency?: number;
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
  execution: { name: "execution", concurrency: 2, globalConcurrency: 2, attempts: 1, backoffMs: 0, retryable: false },
  "execution-small": {
    name: "execution-small",
    concurrency: 2,
    globalConcurrency: 2,
    attempts: 1,
    backoffMs: 0,
    retryable: false,
  },
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
  /**
   * The campaign whose newly enrolled products the worker prices, rather than the scheduler's
   * tick (#808). The variants are not carried: they are the campaign's pending mark, which the
   * job claims when it runs, so a job lost before then loses nothing.
   *
   * Its own field, not `campaignId`: the release before this one knows no enrolment job, and
   * read as an ordinary execution job it would re-apply the whole campaign -- after a revert
   * that stopped part-way, the sale put back on everything the revert had restored (#805).
   * Without a `campaignId` that release's handler does nothing, and its own tick drains the mark.
   */
  enroll?: string;
  /**
   * The campaign whose due scheduled transition this job runs (#809): the tick hands its starts
   * and ends to the worker rather than running each inside itself. The transition is `revert`'s,
   * and the job asks the schedule again when it runs, so one that waited is never stale.
   *
   * Its own field, not `campaignId`, as `enroll` is: read as an ordinary execution job by the
   * release before this one, it would be an unclaimed apply of the whole campaign. Without a
   * `campaignId` that release's handler does nothing, and its own tick runs the transition.
   */
  scheduled?: string;
  /**
   * The next turn of a chunked run (#809, D34): `runId` is the run, which planned and ledgered
   * every price in its first turn and writes the next chunk of them in this one. Asks nothing
   * of the campaign or the schedule: the run's own rows say what is left.
   *
   * Read by the release before this one as an execution job for a run that is not QUEUED, which
   * that release stands down to having done nothing; its reaper then reclaims the waiting run as
   * Partial, and Resume finishes it.
   */
  turn?: boolean;
  /** Who asked, so what the run resolves on their behalf is attributed to them. */
  actor?: string;
  /**
   * An apply pressed on the campaign page without "apply" typed, because the preview it was
   * pressed over did not ask for it (#812). The worker's run checks its own plan before it
   * writes, and refuses where the page can see if that plan asks after all: the preview is
   * stored, and a stored number that was stale must never be what skipped the word.
   */
  untypedPress?: boolean;
  /** Variants the merchant asked to leave as they are, and why (#790). */
  skipVariantGids?: string[];
  skipReason?: string;
  /**
   * A revert from Flow's End campaign, which keeps every price edited outside Anchor (#794).
   * Which ones is worked out by the worker's run, when it runs, and ledgered with `skipReason`.
   */
  keepEdited?: boolean;
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
 *
 * `"later"` is a job that did nothing because its shop is busy: another of the shop's runs, or
 * syncs, holds its lease (#809). It goes back to wait `SHOP_BUSY_RETRY_MS` with its slot given to
 * another shop, and keeps its place as the one job for its work, so a ring meanwhile is
 * absorbed. Inline there is no queue to go back to, and the work waits where it is recorded --
 * a QUEUED row, a claim, a campaign's schedule -- for the tick that rings it next.
 */
export type JobResult = void | "again" | "later" | JobTurn;

/**
 * A chunked run's turn is over and the run goes on (#809, D34): `turn` is the job for its next
 * one, which goes to the back of the same lane, behind every job waiting there, so another shop's
 * run takes the slot between two of this run's chunks. Keyed as the run, like the job it follows,
 * so a ring meanwhile is absorbed. `delayMs` when the next turn has nothing to do sooner: the
 * run's last bulk operation is still running at Shopify. Inline, the next turn runs at once.
 */
export interface JobTurn {
  turn: JobRef;
  delayMs?: number;
}

/** Whether a handler's answer is a chunked run's next turn. */
export function isJobTurn(result: JobResult): result is JobTurn {
  return typeof result === "object" && result !== null && "turn" in result;
}

/**
 * How long a job whose shop is busy waits before it asks again (#809). Short, because it is how
 * late a shop's second run starts after its first finishes; a turn that finds the shop still
 * busy costs one indexed upsert and gives its slot straight back.
 */
export const SHOP_BUSY_RETRY_MS = 5_000;

/** The two lanes a run can go on: the small-run lane and everything else (#809). */
export const RUN_LANES = ["execution", "execution-small"] as const satisfies readonly QueueName[];
export type RunLane = (typeof RUN_LANES)[number];

/** Whether a queue is one of the run lanes, whose jobs are a shop's price writes. */
export function isRunLane(name: QueueName): name is RunLane {
  return (RUN_LANES as readonly QueueName[]).includes(name);
}

/** The lane for a run: the small-run lane when `smallRun` says so (`lib/execution/run-lane.ts`). */
export function laneFor(small: boolean): RunLane {
  return small ? "execution-small" : "execution";
}

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
 * The key a job's duplicates share, for the jobs whose work is a row the worker's tick rings
 * again when it waits too long (#808): a queued run, a catalogue sync, a campaign's
 * enrolments, a campaign's due scheduled transition (#809). A ring of a job still waiting or
 * running -- or put back because its shop was busy -- is absorbed by it; once it has finished,
 * the key is free for the next. Null for every other job, which is never rung twice. The same
 * key on either lane: a run is rung on the lane its row names, so it is only ever on one.
 */
export function jobDedupKey(name: QueueName, ref: JobRef): string | null {
  if (isRunLane(name) && ref.runId) return `run:${ref.runId}`;
  if (isRunLane(name) && ref.enroll) return `enroll:${ref.enroll}`;
  // A campaign's due transition, rung by every tick until it has run (#809).
  if (isRunLane(name) && ref.scheduled) return `scheduled:${ref.scheduled}:${ref.revert ? "revert" : "apply"}`;
  if (name === "sync" && ref.fullSync) return `sync:${ref.shopId}`;
  if (name === "sync" && ref.recaptureId) return `recapture:${ref.recaptureId}`;
  return null;
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
export function jobOptionsFor(
  policy: QueuePolicy,
  ref?: JobRef,
  { again = false, turn = false, delayMs = 0 }: { again?: boolean; turn?: boolean; delayMs?: number } = {},
) {
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
    // BullMQ's simple mode: kept until the job completes or fails, so a ring while it waits or
    // runs adds nothing, and the next press after it adds the next job (#808).
    //
    // A chunked run's next turn is asked for while the job of this turn still holds the run's key
    // (#809, D34), so it keeps the last one asked for as that job's successor, created behind
    // everything already waiting the moment this turn finishes -- as a webhook drain's next turn
    // is. The first turn of a scheduled start holds the schedule's key, not the run's, and its
    // successor is added at once.
    ...(ref && jobDedupKey(policy.name, ref)
      ? { deduplication: { id: jobDedupKey(policy.name, ref)!, ...(turn ? { keepLastIfActive: true } : {}) } }
      : {}),
    ...(turn && delayMs > 0 ? { delay: delayMs } : {}),
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
