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

import { useEffect, useMemo, useState } from "react";
import { isRouteErrorResponse, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { ErrorScreen } from "./ErrorScreen";
import {
  browserReportOf,
  reportBrowserError,
  type BrowserReport,
  type ReferenceState,
} from "../lib/errors/browser-report";
import {
  ANCHOR_ERROR,
  reportErrorSync,
  type ReportedError,
} from "../lib/errors/report";

export function RouteBoundary() {
  const error = useRouteError();

  // Before any early return, because hooks run in the same order every render. Once per
  // error rather than once per render: the screen re-renders, and an id minted in render
  // would change under the merchant's eyes and be posted again each time.
  const inBrowser = useMemo(() => browserFailure(error), [error]);
  const reference = useReportedReference(inBrowser?.report ?? null);

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
  // what to do with these, and intercepting them breaks the embedded flow. (`inBrowser`
  // is null for exactly these, once the guard's own errors have returned above.)
  if (isRouteErrorResponse(error) || error instanceof Response || !inBrowser) {
    return boundary.error(error);
  }

  // A render-time failure in the browser: it never reached the server, so the guard did
  // not store it. Reported here and posted to `/app/error-report` (#783), and the screen
  // promises the reference leads to the detail only once the server says it stored it.
  const { reported } = inBrowser;

  return (
    <ErrorScreen
      errorId={reported.errorId}
      userMessage={reported.userMessage}
      code={reported.code}
      retryable={reported.retryable}
      stack={isDevelopment() && error instanceof Error ? error.stack : null}
      reference={reference}
    />
  );
}

/**
 * An error the boundary has to report itself, with the report it posts -- or null for one
 * the server guard reported, or a Response that belongs to Shopify's handler.
 */
function browserFailure(
  error: unknown,
): { reported: ReportedError; report: BrowserReport | null } | null {
  if (anchorPayload(error) || isRouteErrorResponse(error) || error instanceof Response) return null;

  const route = currentRoute();
  const reported = reportErrorSync(error, { route });
  return {
    reported,
    report: reported.errorId
      ? browserReportOf(error, { errorId: reported.errorId, code: reported.code }, route)
      : null,
  };
}

/**
 * Posts the report once, and says how far the reference can be trusted.
 *
 * `recording` until the server answers, which is also what a server render shows: effects
 * do not run there, and the browser posts once it has taken over. With nothing to post,
 * the error was the server guard's, and its reference is stored already.
 */
function useReportedReference(report: BrowserReport | null): ReferenceState {
  const [answer, setAnswer] = useState<{ errorId: string; state: ReferenceState } | null>(null);

  useEffect(() => {
    if (!report) return;
    let current = true;
    void reportBrowserError(report).then((state) => {
      if (current) setAnswer({ errorId: report.errorId, state });
    });
    return () => {
      current = false;
    };
  }, [report]);

  if (!report) return "recorded";
  return answer?.errorId === report.errorId ? answer.state : "recording";
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
