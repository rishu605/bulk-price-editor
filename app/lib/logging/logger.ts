/**
 * Structured logging.
 *
 * One line per event, JSON in production so it can be queried, and something a human
 * can read at a glance in development. Every line carries the fields you actually
 * search by when something has gone wrong at 2am: the error id the merchant quoted,
 * the shop, the route, and the code.
 *
 * Everything routes through two redaction passes on the way out. `logging/redact`
 * strips secrets -- the object nearest a failed Shopify call is often the one holding
 * an access token. `telemetry/redact` strips prices, which are commercial data that has
 * no business in an aggregator with its own retention and its own access list.
 *
 * Both happen here rather than at every call site, because a rule kept by everyone
 * remembering lasts until somebody adds a field in a hurry.
 */

import { redactPrices } from "../telemetry/redact";
import { redact } from "./redact";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  /** The short id shown to the merchant; the join key between a report and a log. */
  errorId?: string;
  code?: string;
  shop?: string;
  route?: string;
  campaignId?: string;
  runId?: string;
  durationMs?: number;
  [key: string]: unknown;
}

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * `process` does not exist in the browser, and this module is reachable from the
 * ErrorBoundary, which renders on both sides. Reading env through a guard keeps the
 * client bundle from throwing "process is not defined" at the exact moment it is
 * trying to report a different error.
 */
function env(key: string): string | undefined {
  if (typeof process === "undefined" || !process.env) return undefined;
  return process.env[key];
}

function threshold(): number {
  const configured = (env("LOG_LEVEL") ?? "").toLowerCase() as LogLevel;
  if (configured in LEVELS) return LEVELS[configured];
  return env("NODE_ENV") === "production" ? LEVELS.info : LEVELS.debug;
}

function isPretty(): boolean {
  return env("NODE_ENV") !== "production" && env("LOG_FORMAT") !== "json";
}

function emit(level: LogLevel, message: string, fields: LogFields = {}): void {
  if (LEVELS[level] < threshold()) return;

  // Prices first, then secrets. The order matters: the secret pass renders a bigint as
  // "8000n", and a price that has already become a string slips past a money-shaped
  // check. Every price in this codebase is a bigint, so catching it while it still is
  // one is the only reliable pass.
  const safe = redact(redactPrices(fields)) as LogFields;
  const sink = level === "error" ? console.error : level === "warn" ? console.warn : console.log;

  if (isPretty()) {
    const tail = Object.entries(safe)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join(" ");
    sink(`${level.toUpperCase().padEnd(5)} ${message}${tail ? ` ${tail}` : ""}`);
    return;
  }

  sink(JSON.stringify({ level, time: new Date().toISOString(), message, ...safe }));
}

export const logger = {
  debug: (message: string, fields?: LogFields) => emit("debug", message, fields),
  info: (message: string, fields?: LogFields) => emit("info", message, fields),
  warn: (message: string, fields?: LogFields) => emit("warn", message, fields),
  error: (message: string, fields?: LogFields) => emit("error", message, fields),
};

/**
 * Times an operation and logs how long it took.
 *
 * Slow is a failure mode of its own here: a preview that takes 30 seconds is broken
 * even though nothing threw. Failures are logged with their duration too, because
 * "it failed after 60s" and "it failed instantly" have completely different causes.
 */
export async function timed<T>(
  message: string,
  fields: LogFields,
  work: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  try {
    const result = await work();
    logger.debug(message, { ...fields, durationMs: Date.now() - started });
    return result;
  } catch (error) {
    logger.warn(`${message} failed`, {
      ...fields,
      durationMs: Date.now() - started,
      error,
    });
    throw error;
  }
}
