/**
 * A table whose columns do not fit is drawn as a list, never clipped (#804).
 *
 * `s-table` picks grid or list from the frame's width against 490px, never from the
 * table's own width -- `table-fit.ts` quotes the line. So below the width a table's
 * columns need and above 490px, every table in the app was a grid in a sideways scroll
 * box, cut at the card's edge: "708.7" for 708.76 on What's live at 606px, the campaigns
 * list down to slivers of "Last run" and Duplicate.
 *
 * The fix measures each table and asks for the list when the grid is wider than its room.
 * Two halves are tested here, and both are needed:
 *
 * - **The decision.** When to ask for the list, when to give the grid back, and when to
 *   leave Polaris' own choice alone.
 * - **The reach.** That every table is measured at all. The fit runs from `PageShell`, so
 *   a table only gets it if it renders inside a page that goes through the shell and does
 *   not pin `variant` itself.
 *
 * What neither can show is the browser: `scripts/measure-narrow-tables.ts` renders the
 * pages in Chrome with real Polaris at 390 and 606px and fails on any clipped cell.
 */

import { basename } from "node:path";

import { describe, expect, it } from "vitest";

import { sourceFiles, sourceOf } from "../testing/source";
import { FIT_TOLERANCE_PX, fitTable } from "./table-fit";

describe("when a table is asked for its list", () => {
  it("asks when the grid is wider than the room it has", () => {
    // What's live at 606px: a 643px grid in a 440px card.
    expect(fitTable({ layout: "table", available: 440, grid: 643.3, needed: null })).toEqual({
      variant: "list",
      needed: 643.3,
    });
  });

  it("leaves a grid that fits", () => {
    // A grid with room to spare is exactly as wide as its box: `inline-size: 100%`.
    expect(fitTable({ layout: "table", available: 742.4, grid: 742.4, needed: null })).toBeNull();
  });

  it("does not count a pixel of rounding as overflow", () => {
    expect(
      fitTable({ layout: "table", available: 500, grid: 500 + FIT_TOLERANCE_PX, needed: null }),
    ).toBeNull();
    expect(
      fitTable({ layout: "table", available: 500, grid: 500 + FIT_TOLERANCE_PX + 0.5, needed: null }),
    ).toEqual({ variant: "list", needed: 501.5 });
  });

  it("does nothing with a table that is not on screen", () => {
    // A closed tab or a modal that has not opened is zero wide, which would otherwise read
    // as a grid that fits nothing -- and it would come back from that as a list.
    expect(fitTable({ layout: "table", available: 0, grid: 643, needed: null })).toBeNull();
    expect(fitTable({ layout: "list", available: 0, grid: null, needed: 643 })).toBeNull();
  });
});

describe("when a list is given its grid back", () => {
  it("once the room is at least as wide as the grid that did not fit", () => {
    expect(fitTable({ layout: "list", available: 643.3, grid: null, needed: 643.3 })).toEqual({
      variant: "auto",
      needed: null,
    });
    expect(fitTable({ layout: "list", available: 900, grid: null, needed: 643.3 })).toEqual({
      variant: "auto",
      needed: null,
    });
  });

  it("not before, so a table on the edge does not flicker between the two", () => {
    expect(fitTable({ layout: "list", available: 642, grid: null, needed: 643.3 })).toBeNull();
  });

  it("leaves a list Polaris chose for itself", () => {
    // A frame under 490px. Nothing here asked for that list, so nothing here may undo it.
    expect(fitTable({ layout: "list", available: 900, grid: null, needed: null })).toBeNull();
  });
});

/** The numbered copies iCloud leaves beside a file are never part of the app. */
const app = sourceFiles("app").filter((file) => !/ \d+\.tsx?$/.test(file));

describe("every table is in reach of the fit", () => {
  const shell = sourceOf("app", "components", "PageShell.tsx");

  it("runs from the page shell, over the page itself", () => {
    expect(shell).toContain("const fitTables = useTablesFit();");
    // Both branches render their own `s-page`, and a branch without the ref is every page
    // of that shape with no fit at all -- the dashboard has an aside, What's live does not.
    const pages = [...shell.matchAll(/<s-page\b[^>]*>/g)].map((match) => match[0]);
    expect(pages.length).toBeGreaterThanOrEqual(2);
    for (const page of pages) expect(page).toContain("ref={fitTables}");
  });

  it("asks Polaris through the attribute it reads", () => {
    // React 18 hands a custom element its props as attributes; this is the same channel.
    const hook = sourceOf("app", "components", "useTablesFit.ts");
    expect(hook).toContain('setAttribute("variant", change.variant)');
    expect(hook).toContain('[role="grid"]');
  });

  it("finds the tables, so the checks below cannot pass by checking nothing", () => {
    expect(app.filter((file) => sourceOf(file).includes("<s-table")).length).toBeGreaterThan(15);
  });

  it("is not overruled by a table that pins its own variant", () => {
    // React would set it back on every render, and the two would take turns.
    const pinned = app.filter((file) => /<s-table\b[^>]*\bvariant=/.test(sourceOf(file)));
    expect(pinned, "these set variant on an s-table; PageShell decides it").toEqual([]);
  });

  it("is only ever rendered by a page that goes through the shell", () => {
    // A component's table is reached through the route that renders it, so the routes
    // are what is checked: one that renders a table, itself or through any depth of
    // components, has to be a PageShell page.
    const imports = (source: string, name: string) =>
      new RegExp(`import[^;]*\\b${name}\\b[^;]*from`).test(source);

    const components = app.filter((file) => file.startsWith("app/components/") && file.endsWith(".tsx"));
    const tableComponents = new Set(
      components.filter((file) => sourceOf(file).includes("<s-table")).map((file) => basename(file, ".tsx")),
    );
    // Anything that renders a component with a table renders a table, so follow the
    // imports until nothing new turns up: the campaign route reaches `PreviewTable` only
    // through `CampaignPreviewTab`.
    for (let grew = true; grew; ) {
      grew = false;
      for (const file of components) {
        const name = basename(file, ".tsx");
        if (tableComponents.has(name)) continue;
        if ([...tableComponents].some((table) => imports(sourceOf(file), table))) {
          tableComponents.add(name);
          grew = true;
        }
      }
    }
    expect(tableComponents.size).toBeGreaterThan(10);
    expect(tableComponents.has("CampaignPreviewTab"), "the closure follows a component to its table").toBe(true);

    const outside = app
      .filter((file) => file.startsWith("app/routes/") && file.endsWith(".tsx"))
      .filter((file) => {
        const source = sourceOf(file);
        const rendersTable =
          source.includes("<s-table") || [...tableComponents].some((name) => imports(source, name));
        return rendersTable && !source.includes("<PageShell");
      });

    expect(outside, "these render a table outside PageShell, so nothing fits it to its width").toEqual([]);
  });
});
