/**
 * Nothing in this app asks a merchant to type their shop domain.
 *
 * App Store requirement 2.3.1, *Initiate installation from a Shopify-owned surface*:
 *
 * > Your app must not request the manual entry of a myshopify.com URL or a shop's domain
 * > during the installation or configuration flow.
 *
 * The template ships a login page that does exactly that, and it sat at `/auth/login`
 * until #650. It is the kind of thing that returns: the file is the template's, so a
 * future scaffold, a merge from upstream or a copy of another Shopify app brings the field
 * back, and it is invisible from inside the admin because nobody embedded ever sees it.
 *
 * So the check is on the source rather than on a rendered page. Two halves, because each
 * catches what the other misses: a control that takes a domain under some other label, and
 * the string `myshopify` offered as something to type.
 */

import { describe, expect, it } from "vitest";

import { sourceFiles, sourceOf } from "../testing/source";

const files = sourceFiles("app").map((path) => ({ path, source: sourceOf(path) }));

/**
 * Where `myshopify` legitimately appears: the value is *read*, never typed. A shop domain
 * arrives on the session, in a webhook payload, or in the config, and tests build one.
 */
const READS_NOT_ASKS = [
  "shopify.server.ts",
  "services/shop.server.ts",
  "lib/shopify/",
];

describe("no merchant is asked for their shop domain", () => {
  it("finds the app's source", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("has no input whose label or hint names a shop domain", () => {
    const offenders = files
      .filter(({ source }) =>
        /<s-text-field[^>]*(label|placeholder|details)="[^"]*(shop domain|store domain|myshopify)/i.test(
          source,
        ),
      )
      .map(({ path }) => path);

    expect(
      offenders,
      "2.3.1 forbids asking for a myshopify domain; installation starts on Shopify",
    ).toEqual([]);
  });

  it("never offers example.myshopify.com as something to fill in", () => {
    const offenders = files
      .filter(({ path }) => !READS_NOT_ASKS.some((allowed) => path.includes(allowed)))
      .filter(({ source }) => /example\.myshopify\.com/.test(source))
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });

  it("still routes a request that already names its shop", () => {
    // The page renders only when `login()` could not redirect. Losing that call would
    // turn a valid ?shop= install link into a dead end, which is the opposite mistake.
    expect(sourceOf("app/routes/auth.login/route.tsx")).toContain("await login(request)");
  });
});
