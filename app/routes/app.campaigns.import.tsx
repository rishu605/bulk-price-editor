/**
 * `/app/campaigns/import` moved into the campaign editor.
 *
 * #445 made a spreadsheet one of the ways prices change rather than a door of its own: a
 * merchant who wants "these exact prices from this file" and one who wants "20% off this
 * collection" were being sent to two places to make the same object. We had already
 * learned that once — #416 dissolved the Imports nav item on the rule that a nav item is
 * a noun — and this page surviving as a button on the campaigns index was the same
 * mistake one size smaller.
 *
 * Kept because this URL is linked from runbooks and whatever a merchant bookmarked. The
 * POST it used to serve lives at `/app/price-import`, unchanged.
 *
 * Authenticates before redirecting rather than leaving it to the destination: an embedded
 * route reached without a session has to go through OAuth, and doing that here means the
 * merchant lands on the editor rather than bouncing off a second redirect.
 */

import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

import { authenticate } from "../shopify.server";
import { LEGACY_ROUTES } from "../lib/routing/legacy-routes";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return redirect(LEGACY_ROUTES["/app/campaigns/import"]);
};
