/**
 * URLs this app has published, and where they live now.
 *
 * The nav used to carry sixteen top-level items. Shopify's sidebar collapses past
 * seven, so a third of the app sat behind "View more" — the features were built and
 * merchants could not find them. They now group into five sections, which means most
 * of the app changed URL.
 *
 * Those URLs are not ours to break. They are linked from inside the app, from operator
 * alerts, from runbooks a person opens while something is going wrong, and from
 * whatever a merchant bookmarked. A 404 on `/app/debug` at the moment somebody is
 * trying to diagnose a run is the worst possible time to be tidy.
 *
 * This map is the record of that promise, and `legacy-routes.test.ts` holds it to it:
 * every old path has a redirect route, every new path has a route file to land on, and
 * nothing inside the app links through a redirect rather than at the real thing.
 */

export const LEGACY_ROUTES: Readonly<Record<string, string>> = {
  // Prices — five tables over the same variant rows.
  "/app/catalog": "/app/prices",
  "/app/baselines": "/app/prices/baselines",
  "/app/costs": "/app/prices/costs",
  "/app/reconciliation": "/app/prices/live",
  "/app/drift": "/app/prices/drift",

  // Imports — one verb that had three destinations.
  //
  // `/app/prices/import` is the awkward one: it now sits *under* the prices section it
  // used to sound like it belonged to, so it has to redirect out of its own subtree
  // rather than be shadowed by it.
  "/app/prices/import": "/app/imports/prices",
  "/app/baselines/import": "/app/imports/baselines",
  "/app/costs/import": "/app/imports/costs",
  "/app/baselines/recapture": "/app/imports/recapture",

  // Settings — the things a merchant opens once, or when something is wrong.
  "/app/segments": "/app/settings/segments",
  "/app/plan": "/app/settings/plan",
  "/app/feedback": "/app/settings/feedback",
  "/app/debug": "/app/settings/diagnostics",

  // Campaigns — the calendar is a view of the list, not a page of its own.
  //
  // P7.1 pointed this at `/app/campaigns/calendar`, which P7.5 then turned into a
  // redirect itself. Two hops for one old link, and `legacy-routes.test.ts` fails on
  // exactly that, so both now land on the merged view directly.
  "/app/calendar": "/app/campaigns?view=calendar",
  "/app/campaigns/calendar": "/app/campaigns?view=calendar",
};

/**
 * The route files that could serve a URL under `flatRoutes()`.
 *
 * `/app/prices/baselines` is served by `app.prices.baselines.tsx`; `/app/prices` is
 * served by `app.prices._index.tsx`, because `app.prices.tsx` is the section layout
 * and an index route sits beneath it. Which of the two applies depends on whether the
 * path is a section root, so both are returned and the caller accepts either.
 *
 * Derived rather than listed, so the test cannot drift from the routing convention it
 * is checking.
 */
export function routeFilesFor(url: string): [string, string] {
  // A destination may carry a query string -- `/app/campaigns?view=calendar` is served
  // by the campaigns index, not by a route named after its parameters.
  const dotted = url.split("?")[0].replace(/^\//, "").split("/").join(".");
  return [`${dotted}.tsx`, `${dotted}._index.tsx`];
}
