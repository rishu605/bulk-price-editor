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

/** Recent failures for the debug page, newest first. */
export async function recentErrors(shopId: string, limit = 50) {
  return prisma.errorEvent.findMany({
    where: { OR: [{ shopId }, { shopId: null }] },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

/** One failure by the id a merchant quoted. */
export async function errorByPublicId(errorId: string) {
  return prisma.errorEvent.findUnique({ where: { errorId: errorId.trim().toUpperCase() } });
}
