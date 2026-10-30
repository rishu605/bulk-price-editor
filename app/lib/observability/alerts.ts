/**
 * The conditions worth waking somebody for, and the ones that are not.
 *
 * Deliberately pure and deliberately few. An alert that fires on something nobody acts on
 * teaches people to ignore the channel, and the channel is then useless for the alert that
 * matters — so every condition here has to survive the question "what would somebody
 * actually do about this at 3am", and the ones that could not are listed at the bottom as
 * explicitly not alerts.
 *
 * The rule that shapes all of them: **merchant prices are wrong, or about to be.** That is
 * what distinguishes a page from a graph.
 */

export type AlertSeverity = "page" | "notice";

export interface AlertCondition {
  id: string;
  severity: AlertSeverity;
  /** What a human sees. Says the condition, not the metric name. */
  title: string;
  /** Why it matters, in one sentence, so somebody woken by it knows what is at stake. */
  because: string;
  /** Where the runbook is. Every alert has one or it should not be an alert. */
  runbook: string;
}

export interface SignalWindow {
  /** Seconds since the scheduler last reported a tick. */
  secondsSinceTick: number | null;
  /** Worst webhook lag observed in the window, in milliseconds. */
  webhookLagMs: number | null;
  /** Errors in the window, and how many requests they came from. */
  errors: number;
  requests: number;
  /** Fraction of a sampled mirror that disagreed with Shopify. */
  divergenceRate: number | null;
  /** Depth of the execution queue. */
  executionQueueDepth: number | null;
  /**
   * Live variants the nightly audit could not give a base surface row.
   *
   * Distinct from divergence, and the distinction is the whole reason it is here. Divergence
   * is the mirror disagreeing with Shopify; this is the mirror disagreeing with *itself* —
   * a variant present in `variant_index` with no `price_surface_entries` row, which cannot
   * be baselined and therefore cannot be priced. Shopify is not involved and the divergence
   * check cannot see it.
   */
  unpriceableVariants: number | null;
  /**
   * How long the web process's `/healthz` waited for the database, or null when it could
   * not be asked (#803). Read over HTTP because the alerting job runs in the worker, whose
   * pool is its own: the web process can be starved while the worker's queries are fine.
   */
  pagesDatabaseWaitMs: number | null;
  /**
   * Errors and requests broken down by shop, or null when nobody has looked.
   *
   * The global rate above cannot see the incident this is for. One shop whose every
   * campaign is failing — a revoked token, a poisoned catalogue, one market misconfigured
   * — is a handful of errors against everybody else's traffic, so it stays under the
   * global floor and nothing fires while that merchant's prices are stuck. RFC §11 asked
   * for per-shop spikes for exactly this reason.
   */
  shopRates: ShopRate[] | null;
  /**
   * Every queue's depth and how long its longest-waiting job has waited to start, or null
   * when Redis could not be read (#813).
   *
   * The age is what depth cannot say. A dozen shops' webhook drains queued at once (#811)
   * are gone in seconds; one job sitting at the front for ten minutes is a queue nothing is
   * taking from -- and a stalled `webhooks` queue produces no processed deliveries, so
   * `webhook-lag`, computed from those, goes quiet rather than firing.
   */
  queues: QueueSignal[] | null;
  /**
   * How long each shop's longest-waiting run has waited in `execution`, or null when Redis
   * could not be read (#813). Only shops with a run waiting have a row.
   */
  shopRunWaits: ShopRunWait[] | null;
}

export interface QueueSignal {
  queue: string;
  depth: number;
  /** Null when nothing is waiting, which is not the same as a wait of zero. */
  oldestWaitMs: number | null;
}

export interface ShopRunWait {
  shopId: string;
  waitMs: number;
}

export interface ShopRate {
  shopId: string;
  errors: number;
  requests: number;
}

/** How long the scheduler may go quiet before it is presumed stopped. */
export const TICK_SILENCE_SECONDS = 180;

/** Webhook lag above this means the mirror is drifting behind the store. */
export const WEBHOOK_LAG_MS = 5 * 60_000;

/** Errors as a fraction of requests. Above this is a spike, not background noise. */
export const ERROR_RATE = 0.05;

/**
 * Requests a single shop must have produced before its rate means anything.
 *
 * Higher than the global minimum of twenty, and deliberately so: a per-shop denominator
 * is small by construction, and a quiet shop with three deliveries and one failure is a
 * 33% error rate that says nothing. This is the number that decides whether the alert is
 * useful or is the reason somebody mutes the channel.
 */
export const SHOP_SAMPLE_MINIMUM = 25;

/**
 * Variants the audit could not make priceable. The healthy value is zero.
 *
 * A count rather than a rate, because one broken import path on a large catalogue is a
 * rounding error as a proportion and a catastrophe as a fact — every variant it touched is
 * invisible to campaigns. The audit heals what it can from the index, so anything left is
 * something it could not repair.
 */
export const UNPRICEABLE_VARIANTS = 0;

/** Mirror divergence above this is systematic rather than incidental. */
export const DIVERGENCE_RATE = 0.005;

/** Execution jobs waiting. A backlog here means merchant campaigns are late. */
export const EXECUTION_BACKLOG = 50;

/**
 * How long the web process's `/healthz` may wait for the database before somebody is woken
 * for it (#803).
 *
 * `SELECT 1` takes a millisecond; anything over it is time spent waiting for a pooled
 * connection, which every page in the app is doing at the same moment. One shop's
 * 102,132-variant apply ran the pool dry: the check took 6.8 to 10.4 seconds and still said
 * "ok" while every shop's pages were blank. `/healthz` itself reads degraded much earlier,
 * at `DATABASE_WAIT_DEGRADED_MS` in `health.ts` -- a reading, where this is a page.
 */
export const PAGES_DATABASE_WAIT_MS = 5_000;

/**
 * How long a shop's run may wait to start before somebody is woken (#813).
 *
 * An `execution` job is a merchant's Apply, Revert or scheduled end that the worker has not
 * picked up. Two minutes is four ticks, and long past the gate's 30 s for a 1-variant apply;
 * by then the merchant is looking at "Applying" with nothing happening, or a sale is running
 * past its end -- and it is one shop waiting behind another's run, which is #807's failure.
 */
export const RUN_WAIT_MS = 2 * 60_000;

/**
 * How long any other queue's front job may wait before the queue counts as stalled (#813).
 *
 * Ten minutes, because `sync` runs one import at a time and the perf store's takes about
 * three -- a shop waiting behind two of them is busy, not stuck. `execution` has its own,
 * tighter alert above; `audit` has none, for the reason `NOT_ALERTS` gives.
 */
export const QUEUE_STALLED_MS = 10 * 60_000;

/** The queues `queue-stalled` watches: everything with a consequence and no alert of its own. */
const STALL_WATCHED: ReadonlySet<string> = new Set(["sync", "webhooks", "planning", "verification"]);

/**
 * Which alerts a window of signals fires.
 *
 * Returns every condition met rather than the first, because two firing at once is
 * information: a stopped tick *and* an execution backlog is a different incident from
 * either alone.
 */
export function evaluate(window: SignalWindow): AlertCondition[] {
  const firing: AlertCondition[] = [];

  // Null is not zero. A missing signal means we do not know, and alerting on "we do not
  // know" is how a monitoring outage becomes an application incident at 3am.
  if (window.secondsSinceTick !== null && window.secondsSinceTick > TICK_SILENCE_SECONDS) {
    firing.push({
      id: "scheduler-stopped",
      severity: "page",
      title: "The scheduler has stopped",
      because:
        "Scheduled campaigns are not starting and, more importantly, scheduled reverts are " +
        "not running. Every minute of this is a minute a sale runs past its end.",
      runbook: "docs/runbooks.md#alert-scheduler-tick-stopped",
    });
  }

  if (window.webhookLagMs !== null && window.webhookLagMs > WEBHOOK_LAG_MS) {
    firing.push({
      id: "webhook-lag",
      severity: "page",
      title: "Webhooks are more than five minutes behind",
      because:
        "The catalogue mirror is stale, and a campaign planned against a stale mirror prices " +
        "the wrong products.",
      runbook: "docs/runbooks.md#alert-webhooks-more-than-five-minutes-behind",
    });
  }

  if (window.divergenceRate !== null && window.divergenceRate > DIVERGENCE_RATE) {
    firing.push({
      id: "mirror-divergence",
      severity: "page",
      title: "The mirror disagrees with Shopify more than it should",
      because:
        "Above half a percent is systematic rather than incidental, which means the pipeline " +
        "is losing changes rather than dropping the occasional one.",
      runbook: "docs/runbooks.md#alert-mirror-divergence-above-05",
    });
  }

  // A rate needs a denominator worth dividing by. One error in three requests during a
  // quiet night is 33% and means nothing, and an alert that fires on it every night is an
  // alert nobody reads by the end of the week.
  if (window.requests >= 20 && window.errors / window.requests > ERROR_RATE) {
    firing.push({
      id: "error-spike",
      severity: "page",
      title: "Errors are spiking",
      because:
        "More than one request in twenty is failing. Whatever it is, it is affecting " +
        "merchants right now rather than one unlucky one.",
      runbook: "docs/runbooks.md#alert-errors-spiking",
    });
  }

  // Per shop, and separate from the global rate rather than replacing it. The two catch
  // different incidents: the global one is the platform failing everybody a little, this
  // one is one merchant failing completely while the average stays healthy.
  const worst = (window.shopRates ?? [])
    .filter((shop) => shop.requests >= SHOP_SAMPLE_MINIMUM)
    .filter((shop) => shop.errors / shop.requests > ERROR_RATE)
    .sort((a, b) => b.errors / b.requests - a.errors / a.requests)[0];

  if (worst) {
    firing.push({
      id: "shop-error-spike",
      severity: "page",
      title: "One shop is failing while the rest are fine",
      because:
        "More than one request in twenty is failing for a single shop, which the global " +
        "error rate cannot see. That merchant's prices are the ones stuck, and they are " +
        "stuck for a reason particular to them rather than to the platform.",
      runbook: "docs/runbooks.md#alert-one-shop-is-failing",
    });
  }

  if (
    window.executionQueueDepth !== null &&
    window.executionQueueDepth > EXECUTION_BACKLOG
  ) {
    firing.push({
      id: "execution-backlog",
      severity: "notice",
      title: "Campaign execution is falling behind",
      because:
        "Merchant campaigns are queued rather than running. Not urgent on its own, and the " +
        "thing to watch is whether the floor is rising over hours.",
      runbook: "docs/runbooks.md#alert-queue-depth-rising",
    });
  }

  if (
    window.unpriceableVariants !== null &&
    window.unpriceableVariants > UNPRICEABLE_VARIANTS
  ) {
    firing.push({
      id: "unpriceable-variants",
      severity: "page",
      title: "Variants exist that no campaign can price",
      because:
        "These are mirrored, counted and shown in the catalogue, and have no baseline — so " +
        "a campaign silently skips them and the merchant is told nothing. It is how a whole " +
        "catalogue was once importable and unpriceable at the same time.",
      runbook: "docs/runbooks.md#alert-variants-that-cannot-be-priced",
    });
  }

  if (window.pagesDatabaseWaitMs !== null && window.pagesDatabaseWaitMs > PAGES_DATABASE_WAIT_MS) {
    firing.push({
      id: "pages-waiting-for-database",
      severity: "page",
      title: "Pages are waiting for the database",
      because:
        "Every shop's pages are slow or blank, and a run writing prices in the web process can die of a " +
        "pool timeout part-way, leaving prices half-changed (#802). One shop's large write ran the pool dry.",
      runbook: "docs/runbooks.md#alert-pages-waiting-for-the-database",
    });
  }

  // Per shop, the way the error rate is: the backlog alert above counts jobs, and one
  // shop's run waiting behind another's is a single job that no count notices (#813).
  const waiting = (window.shopRunWaits ?? []).filter((shop) => shop.waitMs > RUN_WAIT_MS);
  if (waiting.length > 0) {
    firing.push({
      id: "shop-run-waiting",
      severity: "page",
      title: "A shop's campaign run is waiting to start",
      because:
        "A merchant pressed Apply or Revert, or a scheduled end came due, and the worker has not picked it " +
        "up: their page reads Applying or Reverting with nothing happening, or a sale is running past its end.",
      runbook: "docs/runbooks.md#alert-a-shops-run-is-waiting-to-start",
    });
  }

  // One alert however many queues, for the reason `shop-error-spike` fires once: several
  // queues stalled together is one stopped consumer, and one page.
  const stalled = (window.queues ?? []).filter(
    (queue) => STALL_WATCHED.has(queue.queue) && queue.oldestWaitMs !== null && queue.oldestWaitMs > QUEUE_STALLED_MS,
  );
  if (stalled.length > 0) {
    firing.push({
      id: "queue-stalled",
      severity: "page",
      title: "Background work has stopped being picked up",
      because:
        "A queue's front job has waited more than ten minutes to start. A stalled webhooks or sync queue is a " +
        "mirror going stale with no error anywhere -- the webhook-lag alert reads processed deliveries, and " +
        "there are none.",
      runbook: "docs/runbooks.md#alert-background-work-is-not-being-picked-up",
    });
  }

  return firing;
}

/**
 * Conditions deliberately not alerts.
 *
 * Written down rather than merely absent, because the next person to look at a graph will
 * want to add them, and the reason not to is not obvious from the graph.
 */
export const NOT_ALERTS = [
  {
    condition: "A single variant failed to write",
    because:
      "The ledger records it with a reason and the run reports it. That is the product " +
      "working, and paging for it would page for every large campaign.",
  },
  {
    condition: "A guardrail blocked a campaign",
    because: "A merchant asked for that floor and it held. Nothing is broken.",
  },
  {
    condition: "A campaign is held for drift",
    because:
      "It is waiting for a merchant's decision, not ours. It shows on their dashboard, " +
      "which is where the decision gets made.",
  },
  {
    condition: "A shop's rate-limit budget is saturated",
    because:
      "Normal during a large campaign — the budget manager exists to make it survivable. " +
      "Worth a graph, not a page.",
  },
  {
    condition: "The audit queue is backed up",
    because: "The least urgent thing in the system. It catches up.",
  },
] as const;
