/**
 * The in-page index, and the one way it can rot.
 *
 * The row it replaces was three `s-button href="#guardrails"` pointing at three real
 * `s-section id=` — correct-looking, and it did nothing. Two things are checked here, and
 * the second is the one that will still be earning its keep in a year.
 *
 * **What it renders.** Real anchors, an arrow, no card, and no current item — the last is
 * what stops it becoming the second tab bar it used to look like.
 *
 * **That every target is a section that exists, in order.** A jump row is the one control
 * in the app whose correctness lives in a *different part of the same file*: rename a
 * section's id and the chip still renders, still looks right, and silently scrolls
 * nowhere. Nothing about that shows in a screenshot.
 *
 * The scrolling itself is not testable here — vitest runs in `node`, there is no layout,
 * and the whole reason `scrollIntoView` was chosen over a fragment href is a question
 * about a container Shopify's runtime renders. That gap is real and is stated on the PR
 * rather than papered over with a mock that would pass either way.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { JumpTo } from "./JumpTo";

const html = renderToStaticMarkup(
  <JumpTo
    targets={[
      { id: "guardrails", label: "Guardrails" },
      { id: "rounding", label: "Rounding" },
    ]}
  />,
);

describe("what a jump row is", () => {
  it("renders a real link per target", () => {
    // Not a click handler on a span. Middle-click, open-in-new-tab and copy-link-address
    // all depend on the href being there; the scroll handler is an enhancement over a
    // thing that already means something.
    expect(html).toContain('href="#guardrails"');
    expect(html).toContain('href="#rounding"');
  });

  it("uses chips, because three text labels in a row are a tab bar", () => {
    expect(html).toContain("<s-clickable-chip");
    expect(html).not.toContain("<s-button");
  });

  it("points the arrow down the page", () => {
    // The one thing a tab never does. It is also the whole label — there is no "Jump to"
    // caption, because the arrows say it and the landmark says it to everyone else.
    expect(html).toContain('type="arrow-down"');
    expect(html).not.toContain("Jump to");
  });

  it("draws no card", () => {
    // It sat in an `s-section` holding one line, directly under the section tab bar —
    // the almost-empty rectangle #395 took off the campaigns index.
    expect(html).not.toContain("<s-section");
  });

  it("marks nothing as current", () => {
    // Every target is on the page you are already looking at, so there is nothing to be
    // current. That is the difference between an index and a bar.
    expect(html).not.toMatch(/current/i);
  });

  it("is a landmark a screen reader can name", () => {
    expect(html).toMatch(/accessibilityrole="navigation"/i);
    expect(renderToStaticMarkup(<JumpTo targets={[]} label="Settings" />)).toBe("");
  });
});

const APP = join(process.cwd(), "app");

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return tsxFiles(path);
    return entry.isFile() && entry.name.endsWith(".tsx") && !entry.name.includes(".test.")
      ? [path]
      : [];
  });
}

/** Every file that renders a jump row, with the ids it points at and the ids it has. */
const PAGES = tsxFiles(APP)
  .map((path) => ({ path: path.replace(`${APP}/`, ""), source: readFileSync(path, "utf8") }))
  .filter(({ source }) => source.includes("<JumpTo"))
  .map(({ path, source }) => ({
    path,
    targets: [...source.matchAll(/\{ id: "([^"]+)", label: "[^"]+" \}/g)].map((m) => m[1]),
    sections: [...source.matchAll(/<s-section id="([^"]+)"/g)].map((m) => m[1]),
  }));

describe("a jump row cannot point at a section that is not there", () => {
  it("finds the pages that have one", () => {
    expect(PAGES.map((page) => page.path).sort()).toEqual([
      "components/campaign/CampaignPreviewTab.tsx",
      "routes/app.settings._index.tsx",
      "routes/app.settings.plan.tsx",
    ]);
  });

  it.each(PAGES.map((page) => page.path))("%s targets sections it renders, in order", (path) => {
    const page = PAGES.find((candidate) => candidate.path === path)!;

    expect(page.targets.length).toBeGreaterThanOrEqual(3);
    // Identical lists, not "every target exists": a row whose order disagrees with the
    // page sends a merchant up when the arrow said down.
    expect(page.targets).toEqual(page.sections);
  });
});

describe("it is on the pages that need it and not the ones that do not", () => {
  const routeSections = (source: string) =>
    [...source.matchAll(/<s-section(?![^>]*slot="aside")[^>]*heading="/g)].length;

  it("is absent from every page with fewer than three sections", () => {
    const overreach = tsxFiles(join(APP, "routes"))
      .map((path) => ({ path: path.replace(`${APP}/`, ""), source: readFileSync(path, "utf8") }))
      .filter(({ source }) => source.includes("<JumpTo") && routeSections(source) < 3)
      .map(({ path }) => path);

    expect(overreach, "a two-section page does not need an index of itself").toEqual([]);
  });

  it("stays off Home, whose sections are conditional", () => {
    // Two of them share a heading — "What is live right now" appears twice, for two
    // different states — and which ones render is decided in `lib/dashboard/home.ts`.
    // A fixed index there would list things that are not on the page.
    expect(readFileSync(join(APP, "routes/app._index.tsx"), "utf8")).not.toContain("<JumpTo");
  });
});
