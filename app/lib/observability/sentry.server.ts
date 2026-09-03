/**
 * Sentry, in both processes, and silent when it is not configured.
 *
 * The app already records every failure to `error_events` with an id a merchant can
 * quote. Sentry is not a replacement for that — it is the thing that tells us a failure
 * is happening *now*, across shops, before anybody opens a support ticket. The two answer
 * different questions and both are worth having.
 *
 * **No price ever reaches Sentry.** Same rule as telemetry and Flow, and the same
 * enforcement: everything attached as context goes through the redactor first, and the
 * `beforeSend` hook is the last gate rather than a convention people remember. An
 * exception message can contain a price — "cannot set price 19.99 on…" — so the message
 * is scrubbed too, not only the structured context.
 *
 * Absent DSN means absent Sentry. A deployment without one runs normally and says so once
 * at startup, because an app that refused to boot without an observability vendor would
 * be an app that could not run locally.
 */

import * as Sentry from "@sentry/node";

import { redact, redactText } from "../logging/redact";
import { redactPrices, redactPricesInText } from "../telemetry/redact";
import { logger } from "../logging/logger";

let started = false;

export interface SentryOptions {
  /** Which process this is, so an alert says where it came from. */
  process: "web" | "worker";
  env?: NodeJS.ProcessEnv;
}

export function initSentry(options: SentryOptions): boolean {
  const env = options.env ?? process.env;
  const dsn = env.SENTRY_DSN;

  if (!dsn) {
    // Once, and at info. A deployment without Sentry is a normal state — every local
    // development run is one — and warning about it every boot trains people to ignore
    // the log.
    if (!started) logger.info("no SENTRY_DSN; error reporting is local only");
    started = true;
    return false;
  }

  if (started) return true;
  started = true;

  Sentry.init({
    dsn,
    environment: env.SENTRY_ENVIRONMENT ?? env.NODE_ENV ?? "development",
    // The deployed commit. Without it a stack trace points at a line number in a file
    // that has moved, which is worse than no trace because it looks authoritative.
    release: env.SENTRY_RELEASE ?? env.SOURCE_VERSION ?? undefined,

    // Sampled, because a busy shop's campaign generates thousands of spans and none of
    // them is individually interesting. Errors are always sent; traces are a sample.
    tracesSampleRate: Number(env.SENTRY_TRACES_SAMPLE_RATE ?? 0.05),

    // Off. Shopify's admin runs the app in an iframe and a session replay would record a
    // merchant's catalogue, their prices and their customers' names.
    integrations: (defaults) =>
      defaults.filter((integration) => integration.name !== "LocalVariables"),

    beforeSend(event) {
      return scrub(event);
    },
  });

  Sentry.setTag("process", options.process);

  logger.info("sentry initialised", {
    process: options.process,
    environment: env.SENTRY_ENVIRONMENT ?? env.NODE_ENV ?? "development",
  });

  return true;
}

/**
 * The last gate before anything leaves the process.
 *
 * A hook rather than a convention, because "remember to redact before you capture" is a
 * rule that holds until the first person in a hurry. Exported so it can be tested without
 * initialising the SDK.
 */
export function scrub(event: Sentry.ErrorEvent): Sentry.ErrorEvent {
  if (event.message) event.message = redactText(redactPricesInText(event.message));

  for (const exception of event.exception?.values ?? []) {
    if (exception.value) exception.value = redactText(redactPricesInText(exception.value));
  }

  if (event.extra) {
    event.extra = redact(redactPrices(event.extra)) as Record<string, unknown>;
  }
  if (event.contexts?.anchor) {
    event.contexts.anchor = redact(redactPrices(event.contexts.anchor)) as Record<string, unknown>;
  }

  // Never. A stack frame's local variables are the single most likely place for a price
  // to appear, and no amount of redaction on a structured field helps if the value is
  // sitting in a captured scope.
  delete event.extra?.__serialized__;

  return event;
}

/** Attaches shop context. Never prices — see the note at the top. */
export function setShopContext(shopId: string | null, shop?: string | null): void {
  if (!started) return;

  Sentry.setContext("anchor", {
    shopId: shopId ?? null,
    shop: shop ?? null,
  });
}

/** Reports an error to Sentry, if it is configured. Never throws. */
export function captureError(error: unknown, context: Record<string, unknown> = {}): void {
  if (!started) return;

  try {
    Sentry.withScope((scope) => {
      scope.setContext("anchor", redact(redactPrices(context)) as Record<string, unknown>);
      Sentry.captureException(error);
    });
  } catch {
    // An error inside the error handler replaces a useful message with a useless one and
    // usually loses the original. Swallowed deliberately.
  }
}

/** Test seam: forgets initialisation so a test can start from a known state. */
export function resetSentryForTests(): void {
  started = false;
}

// Re-exported so the callers and tests that knew it here keep working; it now lives
// beside the structured price redactor, which is where the trace path can reach it too.
export { redactPricesInText };
