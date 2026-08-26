import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate } from "../shopify.server";
import { HELP_BASE } from "../lib/errors/help-links.server";
import { RouteBoundary } from "../components/RouteBoundary";
import { RouteProgress } from "../components/RouteProgress";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  // `HELP_BASE` is read from the environment, so it is resolved here rather than in the
  // component — the loader is stripped from the client bundle, `process.env` is not.
  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "", helpBase: HELP_BASE };
};

export default function App() {
  const { apiKey, helpBase } = useLoaderData<typeof loader>();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <RouteProgress />
      <s-app-nav>
        <s-link href="/app">Dashboard</s-link>
        <s-link href="/app/campaigns">Campaigns</s-link>
        <s-link href="/app/calendar">Calendar</s-link>
        <s-link href="/app/segments">Segments</s-link>
        <s-link href="/app/catalog">Catalogue</s-link>
        <s-link href="/app/baselines">Baselines</s-link>
        <s-link href="/app/prices/import">Import prices</s-link>
        <s-link href="/app/baselines/import">Import baselines</s-link>
        <s-link href="/app/costs">Costs</s-link>
        <s-link href="/app/reconciliation">What is live</s-link>
        <s-link href="/app/drift">Drift</s-link>
        <s-link href="/app/activity">Activity</s-link>
        <s-link href="/app/feedback">Feedback</s-link>
        <s-link href="/app/plan">Plan</s-link>
        <s-link href="/app/settings">Settings</s-link>
        <s-link href="/app/debug">Diagnostics</s-link>
        {/* Absolute and a new tab: this renders in an iframe on admin.shopify.com,
            where a relative href would resolve against Shopify rather than us. */}
        <s-link href={helpBase} target="_blank">Help</s-link>
      </s-app-nav>
      <Outlet />
    </AppProvider>
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
