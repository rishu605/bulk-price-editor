import type { LoaderFunctionArgs } from "react-router";

import { legacyRedirect } from "../lib/routing/legacy-redirect.server";

/**
 * `/app/imports/costs` moved to `/app/prices/costs`.
 *
 * Kept because this URL is linked from operator alerts, runbooks and whatever a
 * merchant bookmarked. See `app/lib/routing/legacy-routes.ts`.
 *
 * Through `legacyRedirect`, never a bare `redirect`: the admin's query string is what
 * the destination signs in with, and dropping it left a page reading only "200" (#744).
 */
export const loader = ({ request }: LoaderFunctionArgs) =>
  legacyRedirect(request, "/app/imports/costs");
