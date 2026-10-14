import type { LoaderFunctionArgs } from "react-router";

import { legacyRedirect } from "../lib/routing/legacy-redirect.server";

/**
 * `/app/campaigns/calendar` moved into `/app/campaigns?view=calendar`.
 *
 * P7.1 landed the calendar here as a child route because merging the two loaders was
 * this ticket's work. Now that they are one route, the path it briefly occupied
 * redirects like any other -- it existed long enough to be linked.
 *
 * The query is carried across so a link to a specific week still lands on that week.
 * `legacyRedirect` carries all of it -- the admin's parameters included, which every other
 * stub used to drop (#744) -- so this one only has to say what the old `view` meant.
 */
export const loader = ({ request }: LoaderFunctionArgs) => {
  // `view` used to mean week-or-month here; it means list-or-calendar now. The incoming
  // `view` itself is not carried: the destination's `view=calendar` wins over it.
  const period = new URL(request.url).searchParams.get("view");
  const to = new URLSearchParams();
  if (period === "week" || period === "month") to.set("period", period);

  return legacyRedirect(request, "/app/campaigns/calendar", to);
};
