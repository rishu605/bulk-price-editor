/**
 * OpenTelemetry: where the numbers go when there is somewhere to send them.
 *
 * Metrics already exist — `metric()` has been emitting them as structured log lines since
 * P0.6. That is not a placeholder to be replaced; it is the fallback that keeps working
 * when the collector is down, and it stays. This adds a second sink so the same numbers
 * reach a dashboard that can alert on them.
 *
 * The instruments are created from the same `Metric` union the rest of the app uses, so a
 * metric cannot be exported under a name nothing else knows about. A counter and a
 * histogram behave differently and the distinction is not cosmetic: `run.duration_ms` as a
 * counter would tell you total milliseconds spent, which is a number nobody wants, and
 * `run.rows` as a histogram would lose the total, which is the only thing anybody wants.
 *
 * Absent endpoint means absent exporter, silently. Every local run is a deployment without
 * a collector.
 */

import { metrics, trace, type Counter, type Histogram, type Span, type Tracer } from "@opentelemetry/api";

import { logger } from "../logging/logger";
import { redactPrices } from "../telemetry/redact";
import { redact } from "../logging/redact";
import type { Metric, MetricLabels } from "../telemetry/metrics";

const SERVICE = "anchor";

/**
 * Which instrument each metric is.
 *
 * A counter sums; a histogram describes a distribution. Getting this wrong does not fail
 * — it produces a panel that is quietly meaningless, which is worse than an empty one.
 */
export const INSTRUMENTS: Record<Metric, "counter" | "histogram" | "gauge"> = {
  "run.verified_clean_rate": "gauge",
  "run.duration_ms": "histogram",
  "run.rows": "counter",
  "webhook.lag_ms": "histogram",
  "mirror.divergence_rate": "gauge",
  "scheduler.tick": "counter",
  "budget.saturation": "gauge",
  "queue.depth": "gauge",
  "queue.enqueued": "counter",
  "queue.failed": "counter",
};

let enabled = false;
let sdk: { shutdown(): Promise<void> } | null = null;

const counters = new Map<string, Counter>();
const histograms = new Map<string, Histogram>();
const gauges = new Map<string, number>();

export interface OtelOptions {
  process: "web" | "worker";
  env?: NodeJS.ProcessEnv;
}

/**
 * Starts the SDK when an endpoint is configured.
 *
 * Returns whether it started, so a caller can say so once rather than guessing. Never
 * throws: a misconfigured collector must not stop the app writing prices.
 */
export async function initOtel(options: OtelOptions): Promise<boolean> {
  const env = options.env ?? process.env;
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT;

  if (!endpoint) {
    logger.info("no OTEL_EXPORTER_OTLP_ENDPOINT; metrics stay in the logs");
    return false;
  }

  try {
    const [{ NodeSDK }, { OTLPTraceExporter }, { OTLPMetricExporter }, { PeriodicExportingMetricReader }] =
      await Promise.all([
        import("@opentelemetry/sdk-node"),
        import("@opentelemetry/exporter-trace-otlp-http"),
        import("@opentelemetry/exporter-metrics-otlp-http"),
        import("@opentelemetry/sdk-metrics"),
      ]);

    const instance = new NodeSDK({
      serviceName: SERVICE,
      traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
      metricReader: new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` }),
        exportIntervalMillis: Number(env.OTEL_EXPORT_INTERVAL_MS ?? 30_000),
      }),
    });

    instance.start();
    sdk = instance;
    enabled = true;

    logger.info("opentelemetry started", { process: options.process, endpoint });
    return true;
  } catch (error) {
    // Logged, not thrown. An app that refused to start because a collector was
    // unreachable would be an app that stops writing prices when a dashboard breaks.
    logger.error("could not start opentelemetry; metrics stay in the logs", {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Records one measurement on the right kind of instrument.
 *
 * Labels are redacted on the way through. An attribute is exported verbatim to whoever is
 * collecting, and the rule about prices does not change because the destination is a
 * metrics backend rather than an error tracker.
 */
export function record(name: Metric, value: number, labels: MetricLabels = {}): void {
  if (!enabled) return;

  try {
    const attributes = attributesFrom(labels);
    const meter = metrics.getMeter(SERVICE);

    switch (INSTRUMENTS[name]) {
      case "counter": {
        let counter = counters.get(name);
        if (!counter) {
          counter = meter.createCounter(name);
          counters.set(name, counter);
        }
        counter.add(value, attributes);
        return;
      }

      case "histogram": {
        let histogram = histograms.get(name);
        if (!histogram) {
          histogram = meter.createHistogram(name);
          histograms.set(name, histogram);
        }
        histogram.record(value, attributes);
        return;
      }

      case "gauge": {
        // Observed asynchronously by the SDK, so the value is held and read on export
        // rather than pushed. A gauge pushed on every change would report whichever
        // write happened to land last, which for queue depth is noise.
        gauges.set(gaugeKey(name, attributes), value);
        ensureGauge(name);
        return;
      }
    }
  } catch {
    // A metric is a description of work that already happened. An exporter failing must
    // not be able to change the work.
  }
}

const observed = new Set<string>();

function ensureGauge(name: Metric): void {
  if (observed.has(name)) return;
  observed.add(name);

  const meter = metrics.getMeter(SERVICE);
  const gauge = meter.createObservableGauge(name);

  gauge.addCallback((result) => {
    for (const [key, value] of gauges) {
      if (!key.startsWith(`${name}|`)) continue;
      result.observe(value, JSON.parse(key.slice(name.length + 1)) as Record<string, string>);
    }
  });
}

const gaugeKey = (name: Metric, attributes: Record<string, string | number | boolean>) =>
  `${name}|${JSON.stringify(attributes)}`;

/** Labels as OTel attributes, redacted, with undefined dropped rather than stringified. */
export function attributesFrom(labels: MetricLabels): Record<string, string | number | boolean> {
  const safe = redact(redactPrices(labels)) as Record<string, unknown>;
  const out: Record<string, string | number | boolean> = {};

  for (const [key, value] of Object.entries(safe)) {
    if (value === undefined || value === null) continue;
    out[key] =
      typeof value === "string" || typeof value === "number" || typeof value === "boolean"
        ? value
        : String(value);
  }

  return out;
}

/**
 * Runs work inside a span.
 *
 * A no-op when tracing is off, and it returns the work's own value either way — so a call
 * site reads the same whether or not anybody is collecting, and nobody is tempted to
 * branch on it.
 */
export async function span<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  work: (span: Span | null) => Promise<T>,
): Promise<T> {
  if (!enabled) return work(null);

  const tracer: Tracer = trace.getTracer(SERVICE);

  return tracer.startActiveSpan(name, { attributes }, async (active) => {
    try {
      const result = await work(active);
      active.end();
      return result;
    } catch (error) {
      active.recordException(error as Error);
      active.setStatus({ code: 2 });
      active.end();
      throw error;
    }
  });
}

export async function shutdownOtel(): Promise<void> {
  if (!sdk) return;
  try {
    await sdk.shutdown();
  } catch {
    // Shutting down is best-effort by definition.
  }
  sdk = null;
  enabled = false;
}

/** Test seam. */
export function otelEnabledForTests(value: boolean): void {
  enabled = value;
}
