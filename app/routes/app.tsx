import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { AppBridgeNavigation } from "../components/AppBridgeNavigation";
import { RouteBoundary } from "../components/RouteBoundary";
import { RouteProgress } from "../components/RouteProgress";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  // The API key used to be returned here and handed to `AppProvider`, which rendered the
  // App Bridge script wherever it sat in the tree — inside `<body>`. `root.tsx` owns both
  // scripts now, so that they land in `<head>` where Built for Shopify asks for them.
  return null;
};

export default function App() {
  return (
    <>
      <AppBridgeNavigation />
      <RouteProgress />
      <s-app-nav>
        {/* `rel="home"` rather than a plain link. The admin sidebar already renders the
            app's name as the link to its home route, so an item that also goes there is
            a duplicate — and a named Built for Shopify rejection: "an app has a separate
            navigation item in addition to the app name that redirects to the app's
            homepage". The attribute does both halves of the fix: it points the app name
            at `/app` instead of the default `/`, and it hides this item from the rendered
            menu.

            Spread because `@shopify/polaris-types` does not declare `rel` on `s-link` —
            it is App Bridge reading the attribute off the element, not Polaris, and only
            the Polaris half of the pair ships types. React passes an unknown string prop
            on a dashed tag straight through as an attribute. Both spellings are accepted
            by `renders the home item as rel="home" and not as a menu entry`, in
            `app/lib/compliance/built-for-shopify.test.ts`, so the workaround can be
            dropped whenever the types catch up. */}
        <s-link href="/app" {...{ rel: "home" }}>
          Home
        </s-link>
        <s-link href="/app/campaigns">Campaigns</s-link>
        <s-link href="/app/prices">Prices</s-link>
        <s-link href="/app/settings">Settings</s-link>
        {/* Relative, like every other item, and pointing at an embedded route rather than
            at the help centre itself. An `s-app-nav` href must be a path within the app:
            App Bridge navigates the frame to whatever it is given, so the absolute URL
            that used to be here loaded a non-embedded page into the frame and took
            `host`, `id_token` and `shop` with it. Every nav item went inert from then on.
            `app.help.tsx` has the detail. */}
        <s-link href="/app/help">Help</s-link>
      </s-app-nav>
      <Outlet />
    </>
  );
}

// Thrown Responses still reach Shopify's handler with their headers intact — that is
// how an embedded app re-authenticates. RouteBoundary delegates those and presents
// everything else as a readable error screen.
export function ErrorBoundary() {
  return <RouteBoundary />;
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
