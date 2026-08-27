import { redirect, type LoaderFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import { LEGACY_ROUTES } from "../lib/routing/legacy-routes";

/**
 * `/app/campaigns/calendar` moved into `/app/campaigns?view=calendar`.
 *
 * P7.1 landed the calendar here as a child route because merging the two loaders was
 * this ticket's work. Now that they are one route, the path it briefly occupied
 * redirects like any other -- it existed long enough to be linked.
 *
 * The query is carried across so a link to a specific week still lands on that week.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  const from = new URL(request.url).searchParams;
  const to = new URLSearchParams(from);
  to.set("view", "calendar");
  // `view` used to mean week-or-month here; it means list-or-calendar now.
  const period = from.get("view");
  if (period === "week" || period === "month") to.set("period", period);

  return redirect(`${LEGACY_ROUTES["/app/campaigns/calendar"]}&${to}`);
};
