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
import { metric } from "../telemetry/metrics";
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
 *
 * ## It also times them
 *
 * Every route in the app is already wrapped in one of these, which makes it the one
 * place that can answer "how long does the server take" without instrumenting anything.
 * The question came up when Home appeared blank for twelve seconds and there was no way
 * to tell whether the loader, the embedded-app boot or the host was responsible; by hand
 * on a local machine the answer was 16–30ms, but that is a measurement nobody else can
 * repeat. See #616.
 *
 * A duration and a route name, which is what `CLAUDE.md` allows: counts and durations,
 * never a price and never a product.
 */
export function withGuard<Args, Result>(
  route: string,
  handler: (args: Args) => Promise<Result>,
): (args: Args) => Promise<Result> {
  return async (args: Args) => {
    const started = Date.now();
    const method = (args as { request?: Request })?.request?.method ?? "GET";

    try {
      const result = await handler(args);
      metric("route.server_ms", Date.now() - started, { route, method, outcome: "ok" });
      return result;
    } catch (error) {
      // A redirect or a re-auth bounce is work the route did, not a failure, and timing
      // only the successes would hide the slowest thing a route can do to a merchant.
      if (error instanceof Response) {
        metric("route.server_ms", Date.now() - started, {
          route,
          method,
          outcome: "redirect",
        });
        throw error;
      }

      metric("route.server_ms", Date.now() - started, { route, method, outcome: "error" });

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
