/**
 * The one way an old URL redirects.
 *
 * Every redirect stub in `app/routes/` hands its own path to this and nothing else, and
 * `legacy-routes.test.ts` holds them to it. There used to be twenty-one stubs, each
 * authenticating and redirecting for itself; twenty did it as
 * `return redirect(LEGACY_ROUTES[...])`, which dropped the admin's query string, and every
 * one of those twenty URLs opened on a page reading only "200" (#744). `legacyDestination`
 * explains the mechanism; this file exists so the next stub cannot be written the old way
 * by copying a neighbour.
 */

import { authenticate } from "../../shopify.server";

import { legacyDestination, type LegacyPath } from "./legacy-routes";

/**
 * Authenticate, then send this request on to where `from` lives now, query intact.
 *
 * Authenticates here rather than leaving it to the destination: an embedded route reached
 * without a session has to be sent through Shopify's sign-in, and doing that from here
 * means the merchant lands on the page they asked for instead of bouncing off a second
 * redirect afterwards.
 *
 * The redirect is the one `authenticate.admin` returns, not React Router's. On an
 * ordinary page load the two produce the same 302. They differ on the requests an
 * embedded app sees that an ordinary site does not: when App Bridge re-fetches a page
 * with a fresh session token after the session-token bounce, a 302 would be followed
 * inside that fetch and the merchant left on the bounce URL, so Shopify's answers with
 * App Bridge navigating the frame instead. That is the library's to get right, and using
 * its redirect is how this stays right when it changes.
 *
 * `decided` is for a stub that translates the old page's parameters into the new one's;
 * see `legacyDestination` for which side wins.
 */
export async function legacyRedirect(
  request: Request,
  from: LegacyPath,
  decided?: URLSearchParams,
): Promise<Response> {
  const { redirect } = await authenticate.admin(request);
  return redirect(legacyDestination(from, new URL(request.url).searchParams, decided));
}
