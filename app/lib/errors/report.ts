/**
 * The isomorphic half of error reporting.
 *
 * Lives apart from `services/error-report.server.ts` for a concrete reason: the
 * ErrorBoundary that uses it renders in the browser as well as on the server, and
 * importing the server module there would pull Prisma into the client bundle.
 *
 * So this half normalises, mints an id and logs. Persisting to the database is the
 * server module's job, and only ever called from a loader or action.
 */

import { toAppError } from "./app-error";
import { newErrorId } from "./error-id";
import { logger } from "../logging/logger";

/**
 * Marks a thrown Response as one our server guard produced, so the ErrorBoundary can
 * tell it apart from Shopify's auth redirects. Lives here rather than in guard.server
 * because the boundary runs in the browser and must not import Prisma.
 */
export const ANCHOR_ERROR = "__anchorError";

export interface ReportedError {
  errorId: string;
  code: string;
  userMessage: string;
  retryable: boolean;
  status: number;
}

export function reportErrorSync(
  error: unknown,
  context: Record<string, unknown> = {},
): ReportedError {
  const appError = toAppError(error);
  const errorId = newErrorId();

  logger.error(appError.message, {
    errorId,
    code: appError.code,
    retryable: appError.retryable,
    ...context,
    error: appError.cause ?? appError,
  });

  return {
    errorId,
    code: appError.code,
    userMessage: appError.userMessage,
    retryable: appError.retryable,
    status: appError.status,
  };
}
