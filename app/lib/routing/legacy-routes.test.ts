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

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { LEGACY_ROUTES, routeFilesFor } from "./legacy-routes";

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

  it.each(Object.entries(LEGACY_ROUTES))("%s redirects rather than rendering", (oldUrl) => {
    const file = redirectFileFor(oldUrl).find((f) => routeFiles.has(f))!;
    const source = readFileSync(join(ROUTES_DIR, file), "utf8");
    expect(
      source.includes("LEGACY_ROUTES"),
      `${file} should redirect via LEGACY_ROUTES, so the destination is stated once`,
    ).toBe(true);
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
        // The map itself, and the stubs that read it, are the one place old URLs
        // belong. Keyed on referencing LEGACY_ROUTES at all rather than on a particular
        // call shape: the first version matched `redirect(LEGACY_ROUTES` literally and
        // missed a stub that built its destination with a template literal.
        const source = readFileSync(path, "utf8");
        if (path.includes("legacy-routes")) continue;
        if (source.includes("LEGACY_ROUTES")) continue;

        for (const match of source.matchAll(/["'`](\/app\/[a-z0-9/$._-]*)["'`?#]/gi)) {
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
