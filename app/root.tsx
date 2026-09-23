import type { LoaderFunctionArgs } from "react-router";
import { Links, Meta, Outlet, Scripts, ScrollRestoration, useLoaderData } from "react-router";

/**
 * Whether a request is for the embedded admin, and so whether App Bridge belongs on it.
 *
 * `/app` and everything under it renders inside the Shopify admin iframe. Nothing else
 * does: `_index` redirects, `auth.login` is reached from outside the admin by definition,
 * and `help.$` and `privacy` are public pages a merchant may open from an email or from
 * an expired session. Loading App Bridge on any of those is not merely wasteful — outside
 * the admin it redirects the page *into* the admin, which would make the help centre
 * unreachable exactly when somebody needs it.
 */
function isEmbedded(pathname: string): boolean {
  return pathname === "/app" || pathname.startsWith("/app/");
}

export const loader = ({ request }: LoaderFunctionArgs) => {
  const embedded = isEmbedded(new URL(request.url).pathname);

  // The API key is the app's public client id — it is already in `shopify.app.toml` and
  // goes out on the script tag below — but it is only sent on the documents that use it.
  // eslint-disable-next-line no-undef
  return { embedded, apiKey: embedded ? process.env.SHOPIFY_API_KEY || "" : "" };
};

export default function App() {
  const { embedded, apiKey } = useLoaderData<typeof loader>();

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <link rel="preconnect" href="https://cdn.shopify.com/" />
        {/* Before the stylesheet and before `Links`, deliberately. Built for Shopify asks
            for `app-bridge.js` in the document head, and App Bridge is what reports LCP,
            CLS and INP — the three metrics the performance criteria are graded on — so it
            has to be running before the content it measures paints. It used to render
            from `AppProvider` inside `<body>`, which is where React leaves it.

            No React version moves it for us. React hoists a script only when it carries
            both `src` and `async` — React 18 does not hoist at all, and React 19 added it
            for async scripts specifically, because `async` is what makes a script safe to
            move. App Bridge is deliberately not async: it has to initialise before the
            app renders, which is why Shopify's own snippet is a plain blocking tag in the
            head. So this placement is explicit and has to stay explicit.
            `AppBridgeNavigation` explains the split. */}
        {embedded ? (
          <>
            <script
              src="https://cdn.shopify.com/shopifycloud/app-bridge.js"
              data-api-key={apiKey}
            />
            <script src="https://cdn.shopify.com/shopifycloud/polaris.js" />
          </>
        ) : null}
        <link
          rel="stylesheet"
          href="https://cdn.shopify.com/static/fonts/inter/v4/styles.css"
        />
        <Meta />
        <Links />
      </head>
      <body>
        <Outlet />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}
