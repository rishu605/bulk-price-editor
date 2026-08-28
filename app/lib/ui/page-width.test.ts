/**
 * Nothing gets to render a page the narrow way again.
 *
 * `s-page` defaults to `inlineSize="base"` — a ~660px column that left half a 1300px
 * screen empty. Every route goes through `PageShell` instead, which asks for the full
 * width and rebuilds the `aside` slot that Polaris only renders at `base`.
 *
 * The failure this guards is quiet and specific: a route that writes `<s-page>` itself
 * either gets the old narrow column, or — if it also copies `inlineSize="large"` — gets
 * a page whose asides silently do not render. On the campaign page that is the apply
 * button disappearing with no error.
 *
 * Read from the routes directory rather than a list, so a route added next month is
 * covered without anyone remembering this file exists.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROUTES_DIR = join(process.cwd(), "app", "routes");

/** Route modules that render something. Redirect stubs and resource routes have no JSX. */
function renderingRoutes(): Array<{ name: string; source: string }> {
  return readdirSync(ROUTES_DIR)
    .filter((f) => f.endsWith(".tsx"))
    .map((name) => ({ name, source: readFileSync(join(ROUTES_DIR, name), "utf8") }))
    .filter(({ source }) => source.includes("export default function"));
}

describe("every page is full width", () => {
  it("finds routes to check, so this cannot pass by checking nothing", () => {
    expect(renderingRoutes().length).toBeGreaterThan(15);
  });

  it("routes the page through PageShell rather than s-page", () => {
    const direct = renderingRoutes()
      .filter(({ source }) => source.includes("<s-page"))
      .map(({ name }) => name);

    expect(
      direct,
      "these render s-page directly, so they get the default narrow column — and if " +
        "they set inlineSize themselves, their asides stop rendering with no error",
    ).toEqual([]);
  });

  it("keeps the aside rebuild in one place", () => {
    const shell = readFileSync(join(process.cwd(), "app", "components", "PageShell.tsx"), "utf8");

    expect(shell).toContain('inlineSize="large"');
    expect(
      shell,
      "PageShell is the only thing that may render s-page, because it is the only thing " +
        "that also rebuilds the aside",
    ).toContain("<s-page");
  });
});

describe("routes that use the aside slot", () => {
  it("still have somewhere for it to land", () => {
    const withAside = renderingRoutes().filter(({ source }) => source.includes('slot="aside"'));

    // Not a nice-to-have: an aside that stops rendering does so silently, and the two
    // left are the dashboard's store card and its activity feed — the only things on that
    // page that say what state this shop is actually in.
    //
    // One route, not the thirteen this started with. Ten were prose explaining the app
    // rather than facts about the shop and became `HelpNote`s; two were facts filed away
    // from their subject and moved next to it. The floor moves down with them rather than
    // being deleted: it is here so that "the partition quietly stopped matching anything"
    // fails, and a floor of zero cannot do that.
    expect(withAside.length, "the asides this guards should still exist").toBeGreaterThan(0);

    for (const { name, source } of withAside) {
      expect(source, `${name} uses slot="aside" but does not render inside PageShell`).toContain(
        "PageShell",
      );
    }
  });
});
