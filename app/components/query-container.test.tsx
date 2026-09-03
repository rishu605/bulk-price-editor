/**
 * Every `@container` value is measured against something.
 *
 * A CSS container query resolves against the nearest ancestor container, and an element
 * only becomes one if something sets `container-type` on it. Polaris does that in
 * exactly one place — `s-query-container` — and this app had never used it, so all seven
 * responsive layouts silently took their unmatched branch on every screen.
 *
 * The failure is invisible in two directions at once, which is why it needs a test
 * rather than a habit. Nothing errors, nothing is missing, and the unmatched branch is
 * the *correct* layout for the widest place each component is used — so the page you
 * would look at to check is the page where it looks right. It shows up only where the
 * space is narrow, which is exactly where the collapse was written for.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { sourceOf } from "../lib/testing/source";

import { FieldGrid } from "./FieldGrid";
import { PageShell } from "./PageShell";

const COMPONENTS = join(process.cwd(), "app", "components");

/** Every `.tsx` under `app/components`, tests excluded. */
function componentFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return componentFiles(path);
    if (!entry.name.endsWith(".tsx") || entry.name.includes(".test.")) return [];
    return [path];
  });
}

describe("a container query has a container", () => {
  const files = componentFiles(COMPONENTS);

  it("finds the components, so this cannot pass by checking nothing", () => {
    expect(files.length).toBeGreaterThanOrEqual(30);
  });

  it("every component with a responsive value renders one", () => {
    // Written as a list of offenders rather than a per-file case so the failure names
    // all of them at once — this arrived as seven at a time, and would again if the
    // wrapper were ever refactored out of a shared component.
    const offenders = files
      .filter((path) => {
        const source = sourceOf(path);
        return source.includes("@container (") && !source.includes("<QueryContainer>");
      })
      .map((path) => path.replace(`${COMPONENTS}/`, ""));

    expect(
      offenders,
      "a `@container` value with no container resolves against nothing and always takes its unmatched branch",
    ).toEqual([]);
  });

  it("renders the element Polaris measures", () => {
    // `s-query-container`, not a `div` with `container-type` — Polaris' types require the
    // container name `s-default` on it, which is what a bare `@container (…)` query
    // resolves against.
    expect(sourceOf(join(COMPONENTS, "QueryContainer.tsx"))).toContain("<s-query-container>");
  });
});

describe("the two layouts it changes most", () => {
  it("wraps the field grid, so a narrow column gets one column of fields", () => {
    // The campaign editor's form column is about 470px and `FieldGrid` says it collapses
    // at 700px. It never did, so four selects rendered at roughly 220px each and three
    // of the four truncated their own value.
    const html = renderToStaticMarkup(
      <FieldGrid>
        <s-select label="Rounding" />
      </FieldGrid>,
    );

    expect(html.indexOf("<s-query-container>")).toBeLessThan(html.indexOf("<s-grid"));
  });

  it("wraps the page's two columns, so the aside can fall below the content", () => {
    const html = renderToStaticMarkup(
      <PageShell heading="Campaign">
        <s-section>main</s-section>
        <s-section slot="aside">facts</s-section>
      </PageShell>,
    );

    const container = html.indexOf("<s-query-container>");
    expect(container).toBeGreaterThan(-1);
    expect(container).toBeLessThan(html.indexOf('gridTemplateColumns="@container'));
  });
});
