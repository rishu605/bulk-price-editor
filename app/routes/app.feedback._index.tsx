import { redirect, type LoaderFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import { LEGACY_ROUTES } from "../lib/routing/legacy-routes";

/**
 * `/app/feedback` moved to `/app/settings/feedback`.
 *
 * Kept because this URL is linked from operator alerts, runbooks and whatever a
 * merchant bookmarked. See `app/lib/routing/legacy-routes.ts`.
 *
 * Authenticates before redirecting rather than leaving it to the destination: an
 * embedded route reached without a session has to be sent through OAuth, and doing
 * that from here means the merchant lands on the page they asked for instead of
 * bouncing off a second redirect afterwards.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return redirect(LEGACY_ROUTES["/app/feedback"]);
};
