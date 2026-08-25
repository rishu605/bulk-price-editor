import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate } from "../shopify.server";
import { RouteBoundary } from "../components/RouteBoundary";
import { RouteProgress } from "../components/RouteProgress";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <RouteProgress />
      <s-app-nav>
        <s-link href="/app">Dashboard</s-link>
        <s-link href="/app/campaigns">Campaigns</s-link>
        <s-link href="/app/segments">Segments</s-link>
        <s-link href="/app/catalog">Catalogue</s-link>
        <s-link href="/app/drift">Drift</s-link>
        <s-link href="/app/settings">Settings</s-link>
        <s-link href="/app/debug">Diagnostics</s-link>
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
