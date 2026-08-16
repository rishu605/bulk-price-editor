/**
 * Catching loader and action failures where the real error still exists.
 *
 * React Router sanitises errors before an ErrorBoundary sees them: the message
 * survives, but the properties that make an error identifiable -- Prisma's `code`,
 * the cause chain -- do not. A boundary trying to classify what it receives sees
 * "No Campaign found" with no code attached and can only call it UNKNOWN.
 *
 * So classification, persistence and the id all happen here, on the server, at the
 * moment of failure. The boundary is handed a finished result and only has to render
 * it. That also fixes a subtler problem: an id minted in the boundary was never
 * written to the database, so a merchant quoting it got "no error stored under that
 * reference" -- the one answer a diagnostics page must never give.
 */

import { data } from "react-router";

import { reportError, type ReportContext } from "../../services/error-report.server";
import { ANCHOR_ERROR, type ReportedError } from "./report";

export { ANCHOR_ERROR };

export interface AnchorErrorPayload {
  [ANCHOR_ERROR]: ReportedError;
}

/**
 * Wraps a loader or action so its failures are reported and rendered properly.
 *
 * Thrown Responses pass straight through. That is not an optimisation: Shopify's
 * `authenticate.admin` signals "redirect this embedded app to re-authenticate" by
 * throwing a Response, and swallowing it would replace a silent sign-in with an
 * error screen.
 */
export function withGuard<Args, Result>(
  route: string,
  handler: (args: Args) => Promise<Result>,
): (args: Args) => Promise<Result> {
  return async (args: Args) => {
    try {
      return await handler(args);
    } catch (error) {
      if (error instanceof Response) throw error;

      const request = (args as { request?: Request })?.request;
      const reported = await reportError(error, {
        route,
        method: request?.method,
        ...shopContext(request),
      } as ReportContext);

      throw data({ [ANCHOR_ERROR]: reported }, { status: reported.status });
    }
  };
}

/**
 * The shop domain, taken from the request rather than a session lookup.
 *
 * Deliberately best-effort: this runs while something is already failing, and a
 * second database round trip to enrich a log line is exactly the sort of thing that
 * turns one error into two.
 */
function shopContext(request?: Request): Record<string, unknown> {
  if (!request) return {};
  try {
    return { shop: new URL(request.url).searchParams.get("shop") ?? undefined };
  } catch {
    return {};
  }
}
