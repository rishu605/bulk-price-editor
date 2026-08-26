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
}

/** How long the scheduler may go quiet before it is presumed stopped. */
export const TICK_SILENCE_SECONDS = 180;

/** Webhook lag above this means the mirror is drifting behind the store. */
export const WEBHOOK_LAG_MS = 5 * 60_000;

/** Errors as a fraction of requests. Above this is a spike, not background noise. */
export const ERROR_RATE = 0.05;

/** Mirror divergence above this is systematic rather than incidental. */
export const DIVERGENCE_RATE = 0.005;

/** Execution jobs waiting. A backlog here means merchant campaigns are late. */
export const EXECUTION_BACKLOG = 50;

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
      runbook: "docs/runbooks.md#alert-mirror-divergence-above-05",
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
      runbook: "docs/runbooks.md#stuck-run-recovery",
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
