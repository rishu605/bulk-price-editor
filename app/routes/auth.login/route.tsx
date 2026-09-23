/**
 * Where somebody lands when they open the app's URL from outside the Shopify admin.
 *
 * It used to be the template's login page: a **Shop domain** field with
 * `example.myshopify.com` under it. App Store requirement 2.3.1 forbids exactly that —
 * "your app must not request the manual entry of a myshopify.com URL or a shop's domain
 * during the installation or configuration flow" — and we never needed it.
 * `shopify.app.toml` sets `use_legacy_install_flow = false` and `shopify.server.ts` sets
 * `AppDistribution.AppStore`, so installing starts on Shopify and every embedded request
 * already carries `shop` and `host`.
 *
 * `login()` still runs, because a request that *does* carry a valid `?shop=` is a real
 * entry point and it throws the redirect that starts the install. Only the case it cannot
 * answer reaches the component, and the answer to that case is a direction rather than a
 * field: whoever is here did not forget to type their domain, they arrived from the wrong
 * place.
 */

import { AppProvider } from "@shopify/shopify-app-react-router/react";
import type { LoaderFunctionArgs } from "react-router";

import { login } from "../../shopify.server";
import { Card } from "../../components/Card";
import { Secondary } from "../../components/Type";

const APP_STORE = "https://apps.shopify.com";
const SUPPORT = "rishu605@gmail.com";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  // Throws a redirect when the request names a shop we can install for. Returning at all
  // means it could not, which is the only case this page renders.
  await login(request);

  return null;
};

export default function Auth() {
  return (
    <AppProvider embedded={false}>
      <s-page>
        <Card
          heading="Open Anchor from your Shopify admin"
          lede={
            <>
              Anchor runs inside the Shopify admin, on the store it is installed on. There
              is nothing to sign in to here.
            </>
          }
        >
          <s-unordered-list>
            <s-list-item>
              If you already have Anchor, open your store&apos;s admin, go to Apps, and
              choose Anchor.
            </s-list-item>
            <s-list-item>
              If you do not, install it from the{" "}
              <s-link href={APP_STORE}>Shopify App Store</s-link>, which is the only place
              it installs from.
            </s-list-item>
          </s-unordered-list>

          <Secondary>
            Stuck, or landed here from a link that should have worked? Write to{" "}
            <s-link href={`mailto:${SUPPORT}`}>{SUPPORT}</s-link> and say what you clicked.
          </Secondary>
        </Card>
      </s-page>
    </AppProvider>
  );
}
