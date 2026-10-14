/**
 * Recording a failure once, in a way both halves of the conversation can use.
 *
 * The merchant gets a short id and a sentence. We get the stack, the code, the route
 * and whatever context the call site attached -- stored in a table, so the question
 * "is this one merchant or all of them" is a query rather than a grep through logs
 * that have already rolled over.
 *
 * Reporting must never throw. An error inside the error handler replaces a useful
 * message with a useless one, and usually loses the original entirely.
 */

import prisma from "../db.server";
import { AppError, toAppError } from "../lib/errors/app-error";
import type { ReportedError } from "../lib/errors/report";
import { newErrorId } from "../lib/errors/error-id";
import { logger } from "../lib/logging/logger";
import { redact, redactText } from "../lib/logging/redact";
import { captureError, setShopContext } from "../lib/observability/sentry.server";
import { ROWS_PER_VIEW } from "../lib/ui/table-budget";

export interface ReportContext {
  shopId?: string | null;
  shop?: string | null;
  route?: string;
  method?: string;
  [key: string]: unknown;
}

/**
 * Normalises, logs and stores an error. Returns what the UI should show.
 */
export async function reportError(
  error: unknown,
  context: ReportContext = {},
): Promise<ReportedError> {
  const appError = toAppError(error);
  const errorId = newErrorId();
  const { shopId, shop, route, method, ...rest } = context;

  const merged = { ...appError.context, ...rest };

  // Log first. If the database is what is broken, the log line is all we will get,
  // and losing it to a failed insert would be the worst possible trade.
  logger.error(appError.message, {
    errorId,
    code: appError.code,
    shop: shop ?? undefined,
    route,
    retryable: appError.retryable,
    ...merged,
    error: appError.cause ?? appError,
  });

  // To Sentry as well as the table, and after the log for the same reason. The table
  // answers "is this one merchant or all of them" as a query; Sentry answers "is this
  // happening right now" without anybody asking. Different questions, both worth having,
  // and neither is allowed to fail the other.
  setShopContext(shopId ?? null, shop);
  captureError(appError.cause ?? appError, {
    errorId,
    code: appError.code,
    route,
    ...merged,
  });

  try {
    await prisma.errorEvent.create({
      data: {
        errorId,
        shopId: shopId ?? null,
        code: appError.code,
        message: technicalMessage(appError),
        stack: stackOf(appError)?.slice(0, 8_000) ?? null,
        userMessage: appError.userMessage,
        route: route ?? null,
        method: method ?? null,
        context: redact(merged) as never,
        retryable: appError.retryable,
      },
    });
  } catch (storeFailure) {
    // Deliberately swallowed. The merchant still gets their id and message, and the
    // log line above already carries everything this row would have.
    logger.warn("could not persist error event", {
      errorId,
      error: storeFailure instanceof Error ? storeFailure.message : String(storeFailure),
    });
  }

  return {
    errorId,
    code: appError.code,
    userMessage: appError.userMessage,
    retryable: appError.retryable,
    status: appError.status,
  };
}

// The synchronous reporter lives in lib so the ErrorBoundary can use it without
// pulling Prisma into the client bundle.
export { reportErrorSync } from "../lib/errors/report";

// Both of these go through redactText before they are stored. The message and the
// stack are plain columns rather than part of the context object, so they miss the
// redaction that `redact` applies to structured fields -- and a token pasted into an
// error message is exactly as dangerous as one in a field. This was a real leak: the
// log line was clean while the stored row still held the token.
function technicalMessage(error: AppError): string {
  const cause = error.cause;
  const detail = cause instanceof Error ? cause.message : error.message;
  return redactText(`${error.code}: ${detail}`);
}

function stackOf(error: AppError): string | undefined {
  const cause = error.cause;
  const stack = cause instanceof Error && cause.stack ? cause.stack : error.stack;
  return stack ? redactText(stack) : undefined;
}

/**
 * This shop's recent failures, for its Diagnostics page, newest first.
 *
 * Its own rows only (#717). Unattributed rows -- a failure before a shop was known --
 * used to be included, and since route errors were all stored unattributed, every
 * merchant was shown every other merchant's messages, context and stack traces. They are
 * for operators, who read the table directly.
 */
export async function recentErrors(shopId: string, limit = ROWS_PER_VIEW) {
  return prisma.errorEvent.findMany({
    where: { shopId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

/** One of this shop's failures, by the id its merchant quoted. Another shop's is not found. */
export async function errorByPublicId(shopId: string, errorId: string) {
  return prisma.errorEvent.findFirst({ where: { shopId, errorId: errorId.trim().toUpperCase() } });
}

/**
 * Deletes every failure that belongs to a shop or names it, for `shop/redact` (#785).
 *
 * The one table the cascade from `Shop` does not clear. Its relation is `SetNull`, so
 * deleting the shop detached its errors rather than removing them -- and a row written
 * before the shop was known, or by a path that never resolved it, was never linked in
 * the first place. Both kinds keep text that names the shop: a fetch failure quotes
 * `https://<domain>/admin/...`, a stack carries the URL it was handling, and a call
 * site's context is whatever it attached.
 *
 * So two passes. A row attributed to the shop goes by its id; any row at all whose text
 * names the domain goes by that. The second is a scan of the table, which is fine for a
 * webhook Shopify sends once per shop, 48 hours after it left, over a table the worker
 * keeps to `ERROR_EVENT_DAYS`.
 *
 * Call it before deleting the shop. Afterwards nothing links the attributed rows to it.
 */
export async function forgetShopErrors(domain: string, shopId: string | null): Promise<number> {
  const own = shopId ? (await prisma.errorEvent.deleteMany({ where: { shopId } })).count : 0;

  // Only ever a hostname. An empty or malformed domain would turn the pattern below into
  // one that matches every row, and a redact must never become "delete every error".
  if (!HOSTNAME.test(domain)) return own;

  const named = await prisma.$executeRaw`
    DELETE FROM error_events
    WHERE concat_ws(' ', message, stack, "userMessage", route, context::text) ~* ${mentionOf(domain)}
  `;
  return own + named;
}

const HOSTNAME = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

/**
 * The domain as a whole hostname, for Postgres's `~*`. Bounded on both sides, because a
 * substring match is wrong in the direction that costs someone else: redacting
 * `shop.myshopify.com` would also delete `myshop.myshopify.com`'s errors.
 */
function mentionOf(domain: string): string {
  return `(^|[^a-z0-9-])${domain.replaceAll(".", "\\.")}($|[^a-z0-9-])`;
}

/**
 * How long a failure is kept: long past the moment a merchant quotes its id, and short
 * enough that a table nothing else bounds does not keep a shop's errors for ever (#785).
 */
export const ERROR_EVENT_DAYS = 90;

/**
 * Deletes failures older than `ERROR_EVENT_DAYS`, a batch at a time.
 *
 * Without it the table only ever grew, and a row `shop/redact` could not attribute -- an
 * unattributed failure that did not happen to name its shop -- stayed in it for good.
 * Bounded per call, like the webhook log's, so a backlog drains over a few scheduler
 * ticks rather than in one long delete.
 */
export async function pruneErrorEvents(now: Date = new Date(), batch = 5_000): Promise<number> {
  const cutoff = new Date(now.getTime() - ERROR_EVENT_DAYS * 24 * 60 * 60_000);
  const old = await prisma.errorEvent.findMany({
    where: { createdAt: { lt: cutoff } },
    select: { id: true },
    take: batch,
  });
  if (old.length === 0) return 0;
  const { count } = await prisma.errorEvent.deleteMany({ where: { id: { in: old.map((row) => row.id) } } });
  return count;
}
