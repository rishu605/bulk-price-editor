import { useEffect } from "react";
import { useNavigate } from "react-router";

/**
 * Turns App Bridge navigation events into client-side router navigations.
 *
 * `s-app-nav` does not navigate by itself. Clicking an item dispatches a
 * `shopify:navigate` event on the link and waits for the host app to handle it; with
 * nobody listening, App Bridge falls back to a full document load. That is a Built for
 * Shopify design failure on its own ("no full page reloads"), and it also throws away
 * `host`, `id_token` and `shop`, which is the failure mode `app.tsx` already documents
 * for absolute hrefs.
 *
 * ## Why this is written out rather than imported
 *
 * It is the body of `AppProvider`'s internal `AppBridge` component, which the library
 * does not export on its own. `AppProvider` couples the listener to rendering the
 * `app-bridge.js` script tag *at its own position in the tree* — which is inside
 * `<body>`. Built for Shopify asks for that script in the document head, and the reason
 * is not pedantry: App Bridge is what reports Largest Contentful Paint, Cumulative
 * Layout Shift and Interaction to Next Paint back to Shopify, and those three metrics at
 * the 75th percentile are the performance criteria. A reporter that loads after the
 * content it is supposed to be timing measures the wrong thing.
 *
 * Nothing in React fixes this on its own, now or on a later version. React hoists a
 * script only when it has both `src` and `async`: React 18 does not hoist at all, and
 * React 19 added hoisting for async scripts because `async` is precisely what makes a
 * script safe to move. App Bridge must not be async — it has to initialise before the
 * app renders — so upgrading React would not relocate it. Worth stating because the
 * opposite was believed here for a while, and acting on it would mean deleting the head
 * placement in the belief that the framework had taken it over.
 *
 * So `root.tsx` owns the script tags and this owns the listener. The cost is that a
 * future version of `AppProvider` could grow a responsibility we would not pick up;
 * `built-for-shopify.test.ts` asserts the script is in the head and that exactly one
 * copy of it is loaded, which is the part that would actually break.
 */
export function AppBridgeNavigation() {
  const navigate = useNavigate();

  useEffect(() => {
    const handleNavigate = (event: Event) => {
      const href = (event.target as HTMLElement)?.getAttribute("href");
      if (href) navigate(href);
    };

    document.addEventListener("shopify:navigate", handleNavigate);
    return () => document.removeEventListener("shopify:navigate", handleNavigate);
  }, [navigate]);

  return null;
}
