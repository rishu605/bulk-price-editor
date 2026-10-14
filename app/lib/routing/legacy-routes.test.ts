/**
 * The promise that no published URL 404s.
 *
 * Sixteen nav items became five, so most of the app changed URL. Those URLs are linked
 * from operator alerts, from runbooks somebody opens while a run is misbehaving, and
 * from merchant bookmarks — `/app/debug` going missing at the moment it is most needed
 * is the failure this guards.
 *
 * Every assertion here reads the routes directory rather than a list somebody has to
 * remember to update. A hand-kept list would be checking that two hand-kept lists agree
 * with each other, which is the same shape as the contract-drift bugs this codebase
 * keeps finding: two halves nothing validates.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { sourceOf, withoutComments } from "../testing/source";

import { LEGACY_ROUTES, legacyDestination, routeFilesFor, withQuery } from "./legacy-routes";

const ROUTES_DIR = join(process.cwd(), "app", "routes");
const routeFiles = new Set(readdirSync(ROUTES_DIR).filter((f) => f.endsWith(".tsx")));

/** The route file `flatRoutes()` would serve this old URL from. */
function redirectFileFor(oldUrl: string): string[] {
  return routeFilesFor(oldUrl.replace("/app/", "app/"));
}

describe("every URL this app has published still resolves", () => {
  it.each(Object.entries(LEGACY_ROUTES))("%s still has a route", (oldUrl) => {
    const candidates = redirectFileFor(oldUrl);
    expect(
      candidates.some((f) => routeFiles.has(f)),
      `${oldUrl} has no route file — a merchant's bookmark or an alert link would 404. ` +
        `Expected one of: ${candidates.join(" or ")}`,
    ).toBe(true);
  });

  it.each(Object.entries(LEGACY_ROUTES))("%s redirects through legacyRedirect", (oldUrl) => {
    // Its own path, handed to the one helper -- so the destination is stated once, in the
    // map, and the admin's query string goes with it. Twenty stubs once redirected to
    // `LEGACY_ROUTES[...]` with a bare `redirect`, which dropped `shop`, `host` and
    // `id_token`, and each of those URLs opened on a page reading only "200" (#744).
    const file = redirectFileFor(oldUrl).find((f) => routeFiles.has(f))!;
    const source = sourceOf(ROUTES_DIR, file);
    expect(
      source.includes(`legacyRedirect(request, "${oldUrl}"`),
      `${file} should redirect with legacyRedirect(request, "${oldUrl}")`,
    ).toBe(true);
  });

  it("leaves no stub building its own redirect from the map", () => {
    // The helper is the only reader. A stub that reads LEGACY_ROUTES itself, or calls
    // React Router's `redirect` at all, is the shape that dropped the query string.
    const bypassing = [...routeFiles].filter((file) => {
      const source = sourceOf(ROUTES_DIR, file);
      const readsTheMap = source.includes("LEGACY_ROUTES");
      const isAStub = readsTheMap || source.includes("legacyRedirect(");
      return isAStub && (readsTheMap || /\bredirect\(/.test(source));
    });

    expect(
      bypassing,
      "these redirect an old URL without legacyRedirect, so the admin's query string is " +
        "lost and the page they land on cannot sign in",
    ).toEqual([]);
  });

  it("finds every stub by the call, so the check above cannot pass by matching nothing", () => {
    const callers = [...routeFiles].filter((file) =>
      sourceOf(ROUTES_DIR, file).includes("legacyRedirect("),
    );
    expect(callers).toHaveLength(Object.keys(LEGACY_ROUTES).length);
  });

  it.each(Object.entries(LEGACY_ROUTES))("%s points at a real destination (%s)", (_old, newUrl) => {
    const candidates = routeFilesFor(newUrl.replace("/app/", "app/").replace(/^app$/, "app"));
    expect(
      candidates.some((f) => routeFiles.has(f)),
      `${newUrl} has no route file to land on. Expected one of: ${candidates.join(" or ")}`,
    ).toBe(true);
  });

  it("never redirects to somewhere that redirects again", () => {
    for (const destination of Object.values(LEGACY_ROUTES)) {
      expect(
        LEGACY_ROUTES[destination],
        `${destination} is both a redirect destination and a redirect source — ` +
          `a merchant following an old link would take two hops`,
      ).toBeUndefined();
    }
  });
});

describe("nothing inside the app links through a redirect", () => {
  /** Every `"/app/..."` string literal in the codebase, with where it came from. */
  function internalLinks(): Array<{ file: string; url: string }> {
    const found: Array<{ file: string; url: string }> = [];

    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(path);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue;
        // A test is not a link. `imports.test.ts` asserts the nav no longer contains
        // `/app/imports`, which is the opposite of linking to it, and the pattern below
        // cannot tell an assertion about a URL from a navigation to one.
        if (/\.test\.tsx?$/.test(entry.name)) continue;
        // The map itself, and the stubs that redirect from it, are the one place old
        // URLs belong. A stub names its own old path to `legacyRedirect`, and that
        // literal is the redirect's source, not a link. Keyed on the helper or the map
        // being mentioned at all rather than on a particular call shape: the first
        // version matched `redirect(LEGACY_ROUTES` literally and missed a stub that built
        // its destination with a template literal.
        const source = sourceOf(path);
        if (path.includes("legacy-routes")) continue;
        if (source.includes("LEGACY_ROUTES") || source.includes("legacyRedirect(")) continue;

        // Comments stripped first. Backticked paths in prose — "this was
        // `/app/imports/baselines`" — are how a file explains where it came from, and
        // the pattern below cannot tell one from a link. This is the fourth time this
        // repo has been caught grepping source that includes its own commentary; the
        // compliance check that rejects a native form element still trips on the word
        // `<form` in a sentence.
        const code = withoutComments(source);

        for (const match of code.matchAll(/["'`](\/app\/[a-z0-9/$._-]*)["'`?#]/gi)) {
          found.push({ file: path, url: match[1] });
        }
      }
    };

    walk(join(process.cwd(), "app"));
    return found;
  }

  it("points every link at where the page actually is", () => {
    const stale = internalLinks().filter((link) => LEGACY_ROUTES[link.url] !== undefined);

    expect(
      stale.map((s) => `${s.file.replace(process.cwd() + "/", "")} -> ${s.url}`),
      "these link to an old URL, so following them costs a redirect and they will break " +
        "silently the day the redirect is retired",
    ).toEqual([]);
  });

  it("finds links at all, so the check cannot pass by matching nothing", () => {
    expect(internalLinks().length).toBeGreaterThan(20);
  });
});

/**
 * Carrying a query onto a destination that already has one.
 *
 * `/app/campaigns/calendar?view=week` produced
 * `/app/campaigns?view=calendar&view=calendar&period=week`. Harmless in the sense that
 * nothing read the second one, and not harmless at all in the sense that it is what the
 * address bar showed and what every bookmark and shared link then carried.
 */
describe("withQuery", () => {
  it("does not repeat a key the destination already defines", () => {
    const carried = new URLSearchParams({ view: "calendar" });

    expect(withQuery("/app/campaigns?view=calendar", carried)).toBe(
      "/app/campaigns?view=calendar",
    );
  });

  it("keeps the extra parameters the redirect exists to carry", () => {
    // A link to a specific week still has to land on that week.
    const carried = new URLSearchParams({ view: "calendar", period: "week" });

    expect(withQuery("/app/campaigns?view=calendar", carried)).toBe(
      "/app/campaigns?view=calendar&period=week",
    );
  });

  it("lets the carried value win, so the redirect decides the view", () => {
    const carried = new URLSearchParams({ view: "list" });

    expect(withQuery("/app/campaigns?view=calendar", carried)).toBe(
      "/app/campaigns?view=list",
    );
  });

  it("returns a path, never an absolute URL", () => {
    // The base used to parse a relative destination must not survive into a redirect --
    // an open redirect to a host nobody owns would be a security bug, not a tidiness one.
    const result = withQuery("/app/campaigns?view=calendar", new URLSearchParams());

    expect(result.startsWith("/app/")).toBe(true);
    expect(result).not.toContain("invalid");
    expect(result).not.toContain("//");
  });
});

/**
 * What a redirect carries, and which side wins when both name a key.
 *
 * The admin opens `/app/catalog` as `/app/catalog?embedded=1&host=…&shop=…&id_token=…`,
 * and those parameters are the only thing the next page can sign in with on a document
 * request. Redirecting to the bare destination is what left every old URL on a page
 * reading only "200" (#744). `legacy-redirect.server.test.ts` follows the redirect
 * through Shopify's real `authenticate.admin`; these pin the precedence.
 */
describe("legacyDestination", () => {
  const ADMIN = new URLSearchParams({
    embedded: "1",
    host: "YWRtaW4uc2hvcGlmeS5jb20vc3RvcmUvYW5jaG9y",
    shop: "anchor.myshopify.com",
    id_token: "header.payload.signature",
  });

  it("carries every parameter the admin opened the old URL with", () => {
    const to = new URL(legacyDestination("/app/catalog", ADMIN), "https://example.invalid");

    expect(to.pathname).toBe("/app/prices");
    for (const [key, value] of ADMIN) {
      expect(to.searchParams.get(key), `${key} did not survive the redirect`).toBe(value);
    }
  });

  it("keeps the destination's own query, which is what makes it the right page", () => {
    const to = new URL(legacyDestination("/app/campaigns/import", ADMIN), "https://example.invalid");

    expect(to.pathname).toBe("/app/campaigns/new");
    expect(to.searchParams.get("ruleKind")).toBe("from-file");
    expect(to.searchParams.get("id_token")).toBe(ADMIN.get("id_token"));
  });

  it("lets the destination win over an incoming key of the same name", () => {
    // `view=week` was the old calendar's period; to the campaigns list it means
    // nothing, and letting it through would land a calendar bookmark on the list.
    const incoming = new URLSearchParams({ view: "week" });

    expect(legacyDestination("/app/calendar", incoming)).toBe("/app/campaigns?view=calendar");
  });

  it("lets what the stub decided win over both", () => {
    const incoming = new URLSearchParams({ view: "week", period: "month" });
    const decided = new URLSearchParams({ period: "week" });

    expect(legacyDestination("/app/campaigns/calendar", incoming, decided)).toBe(
      "/app/campaigns?view=calendar&period=week",
    );
  });

  it("keeps a filter a bookmark carried, repeated keys and all", () => {
    const incoming = new URLSearchParams([
      ["tag", "sale"],
      ["tag", "summer"],
    ]);

    expect(legacyDestination("/app/drift", incoming)).toBe("/app/prices/drift?tag=sale&tag=summer");
  });

  it("returns a path, never an absolute URL", () => {
    const result = legacyDestination("/app/debug", ADMIN);

    expect(result.startsWith("/app/settings/diagnostics?")).toBe(true);
    expect(result).not.toContain("invalid");
    expect(result).not.toContain("//");
  });
});
