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

/**
 * The campaign editor, opened on the spreadsheet option.
 *
 * Named once because four old URLs point at it, and a query string repeated four times
 * is four chances to write `rule-kind` in one of them.
 */
const FROM_A_FILE = "/app/campaigns/new?ruleKind=from-file";

export const LEGACY_ROUTES: Readonly<Record<string, string>> = {
  // Prices — five tables over the same variant rows.
  "/app/catalog": "/app/prices",
  "/app/baselines": "/app/prices/baselines",
  "/app/costs": "/app/prices/costs",
  "/app/reconciliation": "/app/prices/live",
  "/app/drift": "/app/prices/drift",

  // Imports — a verb that had a nav item, and does not any more.
  //
  // Every one of these now lands on the noun it acts on: baselines and costs are
  // imported from the pages that list them, and a price file makes a campaign, so it
  // lives with campaigns. That collapse is why the first four changed destination rather
  // than being added to — pointing `/app/prices/import` at `/app/imports/prices` and
  // `/app/imports/prices` onward is exactly the two-hop chain this file's test forbids,
  // so both go straight to the page.
  "/app/prices/import": FROM_A_FILE,
  "/app/baselines/import": "/app/prices/baselines",
  "/app/costs/import": "/app/prices/costs",
  "/app/baselines/recapture": "/app/prices/baselines/recapture",

  "/app/imports": FROM_A_FILE,
  "/app/imports/prices": FROM_A_FILE,

  // And the page those three used to land on.
  //
  // #445 made a spreadsheet one of the ways prices change rather than a door of its own:
  // a merchant who wants "these exact prices from this file" and one who wants "20% off
  // this collection" were being sent to two places to make the same object. The import's
  // action, parsing, dry run and error reporting are unchanged — it is the *entrance*
  // that moved, and this route still serves the form's POST.
  //
  // The three above were repointed rather than left aimed here: `/app/imports/prices` →
  // `/app/campaigns/import` → the editor is the two-hop chain this file's test forbids.
  "/app/campaigns/import": FROM_A_FILE,
  "/app/imports/baselines": "/app/prices/baselines",
  "/app/imports/costs": "/app/prices/costs",
  "/app/imports/recapture": "/app/prices/baselines/recapture",

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
