/**
 * The one ErrorBoundary every route uses.
 *
 * The split matters. Shopify's `boundary.error` is not a nicety -- an embedded app
 * re-authenticates by *throwing a Response*, and that Response has to reach Shopify's
 * handler with its headers intact or the app hangs on a blank frame instead of
 * silently signing back in. So thrown Responses are delegated, always.
 *
 * Genuine exceptions are ours to present. Those get the error screen, with an id the
 * merchant can quote, rather than a stack trace and a dead page.
 */

import { isRouteErrorResponse, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { ErrorScreen } from "./ErrorScreen";
import {
  ANCHOR_ERROR,
  reportErrorSync,
  type ReportedError,
} from "../lib/errors/report";

export function RouteBoundary() {
  const error = useRouteError();

  // Our own guard already classified, stored and titled this one on the server. The
  // boundary just renders it -- crucially including an id that really is in the
  // database, so looking it up on the Diagnostics page finds something.
  const reportedOnServer = anchorPayload(error);
  if (reportedOnServer) {
    return (
      <ErrorScreen
        errorId={reportedOnServer.errorId}
        userMessage={reportedOnServer.userMessage}
        code={reportedOnServer.code}
        retryable={reportedOnServer.retryable}
      />
    );
  }

  // Auth redirects and anything else thrown as a Response: Shopify's handler knows
  // what to do with these, and intercepting them breaks the embedded flow.
  if (isRouteErrorResponse(error) || error instanceof Response) {
    return boundary.error(error);
  }

  // A render-time failure in the browser: never reached the server, so it is reported
  // here. These are rarer and cannot be persisted from the client.
  const reported = reportErrorSync(error, { route: currentRoute() });

  return (
    <ErrorScreen
      errorId={reported.errorId}
      userMessage={reported.userMessage}
      code={reported.code}
      retryable={reported.retryable}
      stack={isDevelopment() && error instanceof Error ? error.stack : null}
    />
  );
}

/**
 * Recognises a failure our server guard already handled.
 *
 * The tag matters: an untagged Response is Shopify's (auth, redirects) and must be
 * delegated, so "is this ours" cannot be answered by status code alone.
 */
function anchorPayload(error: unknown): ReportedError | null {
  if (!isRouteErrorResponse(error)) return null;
  const payload = (error.data as Record<string, unknown> | null)?.[ANCHOR_ERROR];
  return payload ? (payload as ReportedError) : null;
}

function currentRoute(): string | undefined {
  if (typeof window === "undefined") return undefined;
  return window.location?.pathname;
}

function isDevelopment(): boolean {
  // Same guard as the logger: this renders in the browser too.
  if (typeof process === "undefined" || !process.env) return false;
  return process.env.NODE_ENV !== "production";
}
