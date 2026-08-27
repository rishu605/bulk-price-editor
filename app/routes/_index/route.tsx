import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

/**
 * The app URL is an entry point, not a landing page.
 *
 * Shopify loads it with the full OAuth query string when the admin opens the app cold, but
 * clicking the app's name in the admin sidebar navigates the already-loaded iframe here
 * with no query string at all. Both mean "open the app", so both belong on the app home;
 * `/app` owns authentication and knows how to recover a session through App Bridge.
 *
 * Only a top-level document request without a shop can be somebody typing the URL outside
 * the admin. They have to name their shop first, and that form already exists at
 * `/auth/login` — this route does not duplicate it.
 */
export const loader = ({ request }: LoaderFunctionArgs) => {
  const { search, searchParams } = new URL(request.url);
  const outsideAdmin =
    !searchParams.get("shop") &&
    request.headers.get("sec-fetch-dest") === "document";

  throw redirect(outsideAdmin ? "/auth/login" : `/app${search}`);
};
