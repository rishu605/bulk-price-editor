/**
 * Every old URL, opened the way the admin opens it, followed the way the browser follows it.
 *
 * #744: each of these URLs opened on a page reading only "200". The redirect itself was
 * fine -- right status, right path -- which is why `legacy-routes.test.ts` passed for
 * months. What broke was the request *after* it. The admin loads the app's iframe with
 * `embedded`, `shop`, `host` and `id_token` on the query string, a document request has
 * no other way to say which shop it is, and the stubs redirected to the bare destination.
 * The destination's `authenticate.admin` then found no shop and threw back an App Bridge
 * script tag with status 200, which the merchant saw as the number alone.
 *
 * So nothing here is mocked that decides the outcome. `authenticate` is Shopify's real
 * one, built from the library's own test config with an in-memory session store; the
 * session token is signed with that config's secret, exactly as the admin's would be; and
 * the follow-up request is built the way a browser builds it from a `Location` header --
 * a plain GET with no headers at all. The only stand-in is the store's offline session,
 * which in production is the row the install wrote.
 */

import { createHmac } from "node:crypto";

import { beforeAll, describe, expect, it, vi } from "vitest";
import type { LoaderFunction, LoaderFunctionArgs } from "react-router";
import { Session } from "@shopify/shopify-app-react-router/server";
import { testConfig } from "@shopify/shopify-app-react-router/test-helpers";

import { authenticate, sessionStorage } from "../../shopify.server";

import { LEGACY_ROUTES, routeFilesFor } from "./legacy-routes";

vi.mock("../../shopify.server", async () => {
  await import("@shopify/shopify-app-react-router/adapters/node");
  const { AppDistribution, LogSeverity, shopifyApp } = await import(
    "@shopify/shopify-app-react-router/server"
  );
  const { testConfig } = await import("@shopify/shopify-app-react-router/test-helpers");
  const { API_VERSION } = await import("../shopify/api-version");

  const shopify = shopifyApp(
    testConfig({
      apiVersion: API_VERSION,
      // The distribution production runs, which is what makes this an embedded app and
      // what puts `redirect` on the context at all.
      distribution: AppDistribution.AppStore,
      logger: { level: LogSeverity.Error },
    }),
  );
  return {
    default: shopify,
    authenticate: shopify.authenticate,
    sessionStorage: shopify.sessionStorage,
  };
});

const { apiKey, apiSecretKey, appUrl } = testConfig();
const SHOP = "anchor-test.myshopify.com";
const HOST = Buffer.from(`admin.shopify.com/store/anchor-test`).toString("base64");

/** An HS256 session token, signed with the app's secret the way the admin signs one. */
function sessionToken(): string {
  const now = Math.floor(Date.now() / 1000);
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${part({ alg: "HS256", typ: "JWT" })}.${part({
    iss: `https://${SHOP}/admin`,
    dest: `https://${SHOP}`,
    aud: apiKey,
    sub: "1",
    exp: now + 60,
    nbf: now - 5,
    iat: now - 5,
    jti: "legacy-redirect-test",
    sid: "legacy-redirect-test",
  })}`;
  const signature = createHmac("sha256", apiSecretKey).update(unsigned).digest("base64url");
  return `${unsigned}.${signature}`;
}

/** The iframe request the admin makes for `path`, query string and all. */
function openedInTheAdmin(path: string): Request {
  const url = new URL(path, appUrl);
  url.searchParams.set("embedded", "1");
  url.searchParams.set("hmac", "unchecked-on-token-exchange");
  url.searchParams.set("host", HOST);
  url.searchParams.set("id_token", sessionToken());
  url.searchParams.set("locale", "en");
  url.searchParams.set("session", "admin-session");
  url.searchParams.set("shop", SHOP);
  url.searchParams.set("timestamp", String(Math.floor(Date.now() / 1000)));
  return new Request(url);
}

/** What the browser does with a 302 inside the iframe: GET the Location, no headers. */
function followed(redirect: Response, from: Request): Request {
  const location = redirect.headers.get("Location");
  expect(location, "a redirect with no Location").toBeTruthy();
  return new Request(new URL(location!, from.url));
}

/** A loader's answer, whether it returned it or threw it -- `authenticate` does both. */
async function settle(answer: () => unknown): Promise<Response> {
  try {
    return (await answer()) as Response;
  } catch (thrown) {
    if (thrown instanceof Response) return thrown;
    throw thrown;
  }
}

/** Whether the destination page would sign in, or what it answered instead. */
async function signsIn(request: Request): Promise<string> {
  try {
    const { session } = await authenticate.admin(request);
    return `signed in as ${session.shop}`;
  } catch (thrown) {
    if (!(thrown instanceof Response)) throw thrown;
    // A 200 here is #744 exactly: App Bridge's script tag in place of the page.
    return `answered ${thrown.status} instead of the page`;
  }
}

const stubs = import.meta.glob<{ loader: LoaderFunction }>("../../routes/app.*.tsx");

/** The loader serving an old URL, found the way `flatRoutes()` finds it. */
async function loaderFor(oldUrl: string): Promise<LoaderFunction> {
  const file = routeFilesFor(oldUrl)
    .map((name) => `../../routes/${name}`)
    .find((path) => path in stubs);
  expect(file, `no route file serves ${oldUrl}`).toBeTruthy();
  return (await stubs[file!]()).loader;
}

function run(loader: LoaderFunction, request: Request) {
  return settle(() => loader({ request, params: {}, context: {} } as LoaderFunctionArgs));
}

beforeAll(async () => {
  // The offline session the install wrote. With it stored, token exchange has nothing to
  // exchange, so nothing here reaches Shopify over the network.
  await sessionStorage.storeSession(
    new Session({
      id: `offline_${SHOP}`,
      shop: SHOP,
      state: "",
      isOnline: false,
      accessToken: "offline-token",
      scope: "write_products",
    }),
  );
});

describe("an old URL opened inside the admin", () => {
  it.each(Object.entries(LEGACY_ROUTES))("%s lands on %s, signed in", async (oldUrl, newUrl) => {
    const opened = openedInTheAdmin(oldUrl);
    const redirect = await run(await loaderFor(oldUrl), opened);

    expect(redirect.status, `${oldUrl} should redirect`).toBe(302);

    const next = followed(redirect, opened);
    const landed = new URL(next.url);
    const promised = new URL(newUrl, appUrl);

    expect(landed.pathname).toBe(promised.pathname);
    for (const [key, value] of promised.searchParams) {
      expect(landed.searchParams.get(key), `${newUrl} lost its own ${key}`).toBe(value);
    }

    // The assertion #744 needed. A bare redirect reaches here with no shop, and the
    // destination answers 200 with a script tag -- the "200" a merchant saw.
    expect(await signsIn(next)).toBe(`signed in as ${SHOP}`);
  });

  it("still lands a bookmark of a week on that week", async () => {
    const opened = openedInTheAdmin("/app/campaigns/calendar?view=week");
    const redirect = await run(await loaderFor("/app/campaigns/calendar"), opened);
    const landed = new URL(followed(redirect, opened).url);

    expect(landed.searchParams.getAll("view")).toEqual(["calendar"]);
    expect(landed.searchParams.get("period")).toBe("week");
    expect(landed.searchParams.get("shop")).toBe(SHOP);
  });

  it("re-fetched by App Bridge after the session-token bounce, navigates the frame rather than 302", async () => {
    // A 302 here would be followed inside App Bridge's fetch, leaving the merchant on the
    // bounce URL. Shopify's redirect answers with App Bridge opening the destination in
    // the frame instead, and that is the reason the stubs use it rather than React
    // Router's: this is the case a plain `redirect` gets wrong.
    const url = new URL("/app/catalog", appUrl);
    url.searchParams.set("embedded", "1");
    url.searchParams.set("shop", SHOP);
    url.searchParams.set("host", HOST);
    const bounced = new Request(url, {
      headers: { Authorization: `Bearer ${sessionToken()}`, "X-Shopify-Bounce": "1" },
    });

    const answer = await run(await loaderFor("/app/catalog"), bounced);
    const body = await answer.text();

    expect(answer.status).toBe(200);
    expect(body).toContain(`window.open("${appUrl}/app/prices?`);
    expect(body).toContain(`"_self"`);
  });
});
