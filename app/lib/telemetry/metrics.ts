/**
 * The numbers that say whether this app is working.
 *
 * Emitted as structured lines rather than through an OpenTelemetry SDK. That is a
 * deliberate stopping point, not an oversight: the SDK is a large dependency whose
 * export is inert without a collector, and there is no collector until there is a
 * staging environment. A named metric with typed labels on stdout is scrapeable by
 * anything, costs nothing, and is the same shape an exporter would take later — so
 * adding one is wiring, not rework.
 *
 * The panel names come from RFC §11 and are fixed here so the dashboard, the alerts and
 * the code cannot drift apart by someone renaming a string.
 *
 * Labels never carry a price. They go through the same redaction as logs, because a
 * metric label is if anything worse than a log line: it is high-cardinality, retained
 * for a long time, and indexed.
 */

import { logger } from "../logging/logger";
import { record as recordOtel } from "../observability/otel.server";

/** The SLO panels. Stubbed where the feature does not exist yet, named so they can be. */
export type Metric =
  /** Fraction of runs where every row was read back and confirmed. The headline. */
  | "run.verified_clean_rate"
  /** How long a run took, end to end. */
  | "run.duration_ms"
  /** Rows a run wrote, by outcome. */
  | "run.rows"
  /** Delay between Shopify sending a webhook and us processing it. */
  | "webhook.lag_ms"
  /** Fraction of a sampled mirror that disagreed with Shopify. */
  | "mirror.divergence_rate"
  /**
   * Live variants with no base surface row — mirrored, but impossible to price.
   *
   * A count rather than a rate, because the healthy value is zero and any other value
   * means an import path has stopped writing surface rows. A rate would make one broken
   * path on a large catalogue look like a rounding error.
   */
  | "mirror.unpriceable"
  /** That the scheduler is alive and doing work. */
  | "scheduler.tick"
  /** How much of a shop's rate-limit budget a run consumed. */
  | "budget.saturation"
  /** Jobs waiting. Zero is healthy; a rising floor is not. */
  | "queue.depth"
  /** Jobs accepted onto a queue, by class. */
  | "queue.enqueued"
  /** Jobs that exhausted their attempts. A class failing every attempt is the thing an
   * operator most needs to know, and the queue library's default is silence. */
  | "queue.failed";

export interface MetricLabels {
  shopId?: string;
  runId?: string;
  campaignId?: string;
  /** Free-form, redacted like everything else. Never a price. */
  [key: string]: string | number | boolean | undefined;
}

/**
 * Records one measurement.
 *
 * Never throws. A metric is a description of work that already happened; an exporter
 * failing must not be able to change the work.
 */
export function metric(name: Metric, value: number, labels: MetricLabels = {}): void {
  try {
    // The log line stays, and is not a placeholder for the exporter. It is the sink that
    // keeps working when the collector is down, which is exactly when somebody is trying
    // to work out what happened.
    logger.info("metric", { metric: name, value, ...labels });
    recordOtel(name, value, labels);
  } catch {
    // Deliberately silent. There is nothing useful to do when the thing that reports
    // problems is the problem, and recursing into the logger to say so is worse.
  }
}

/**
 * A rate expressed as a fraction, guarding the empty case.
 *
 * Zero out of zero is not a zero rate — it is no data. Reporting it as 0 would make an
 * idle shop indistinguishable from a completely broken one on the same panel, and the
 * alert built on that panel would fire on the wrong one.
 */
export function rate(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return numerator / denominator;
}
