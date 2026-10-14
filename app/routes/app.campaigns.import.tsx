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
 * Through `legacyRedirect`, never a bare `redirect`: the admin's query string is what the
 * editor signs in with, and dropping it is why this URL opened on a page reading only
 * "200" (#744).
 */

import type { LoaderFunctionArgs } from "react-router";

import { legacyRedirect } from "../lib/routing/legacy-redirect.server";

export const loader = ({ request }: LoaderFunctionArgs) =>
  legacyRedirect(request, "/app/campaigns/import");
