/**
 * There is one tab bar, and every set of tabs uses it.
 *
 * Three had grown independently — the section nav, the campaign page's `?tab=`, and the
 * campaigns index's list/calendar toggle. Only the section one looked like a control;
 * the other two were a bold word beside a blue link, and the index one wrapped the
 * current view in a link back to the page you were already on.
 *
 * They drifted because each arrived with its own ticket, scoped to its own page. That is
 * the shape of the bug, so the test is not "the bar looks right" but "nobody has written
 * a second one".
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";

import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router";
import { describe, expect, it } from "vitest";

import { sourceOf } from "../lib/testing/source";

import { TabBar, type Tab } from "./TabBar";
import { PAD } from "../lib/ui/spacing";

const ROOT = process.cwd();
const bar = sourceOf("app/components/TabBar.tsx");

/**
 * The bar as a merchant's browser receives it.
 *
 * Inside a router because the tabs that are not current are real `Link`s -- which is the
 * point of them, and which throws outside one.
 */
const render = (tabs: Tab[], action?: ReactNode) =>
  renderToStaticMarkup(
    <StaticRouter location="/app/campaigns">
      <TabBar label="Campaign views" tabs={tabs} action={action} />
    </StaticRouter>,
  );

const occurrences = (html: string, needle: string) => html.split(needle).length - 1;

/** One tab selected and one not -- the only case where the two branches can disagree. */
const bothTabs = render([
  { label: "List", href: "?view=list", current: true },
  { label: "Calendar", href: "?view=calendar", current: false },
]);

/** Every source file under app/, minus tests. */
function sources(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return sources(path);
    if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) return [];
    return [path];
  });
}

const files = sources("app").map((path) => ({
  path,
  source: sourceOf(path),
}));

describe("every set of tabs uses the shared bar", () => {
  it.each([
    "app/components/SectionTabs.tsx",
    "app/components/campaign/CampaignTabs.tsx",
    // The campaigns *index* no longer appears here, and its list view does instead. The
    // page used to render two bars stacked — List/Calendar, then the status filter — and
    // the top one is a view switch in the title bar now. One question per control: the
    // tabs filter what is in the list, and a button swaps which shape the list takes.
    "app/components/campaign/CampaignListView.tsx",
  ])("%s renders TabBar rather than its own row", (path) => {
    const source = files.find((file) => file.path === path)?.source ?? "";
    expect(source, `${path} should be a known tab surface`).not.toBe("");
    expect(source).toMatch(/import \{ TabBar \} from/);
  });

  /**
   * A tab bar is a navigation landmark. The app's own sections are the only navigation
   * this app renders -- everything else is Shopify's chrome -- so a second file claiming
   * the role is a second bar, whatever it is called.
   *
   * This briefly allowed a second entry, for an in-page index of jump links. That was
   * removed: a row of chips under the tab bar read as more chrome rather than as help,
   * and the page it was meant to make navigable is better served by being shorter.
   */
  it("finds no fourth implementation", () => {
    const landmarks = files
      .filter((file) => file.source.includes('accessibilityRole="navigation"'))
      .map((file) => file.path);

    expect(landmarks, "one bar, one landmark").toEqual(["app/components/TabBar.tsx"]);
  });


  it("never links the tab you are already on", () => {
    // The index toggle did exactly this: `<s-link href={current}>` around the view you
    // were looking at, so the control's most likely click did nothing.
    for (const { path, source } of files) {
      if (path === "app/components/TabBar.tsx") continue;
      expect(
        source,
        `${path} builds a self-referential tab link instead of using TabBar`,
      ).not.toMatch(/view === "(list|calendar)" \? <s-text type="strong">/);
    }
  });
});

describe("the bar itself", () => {
  it("pads every tab the same, so the row does not twitch on selection", () => {
    // This shipped broken: the current tab was a padded pill and the others were bare
    // text, so the row shifted sideways on every click. It broke because the two branches
    // were written out separately and only *looked* like they matched.
    //
    // Asserting on the rendered markup rather than on the source, because the fix is that
    // both branches now render one shared node -- and a source check for "padding appears
    // in both branches" cannot tell that apart from the bug it is meant to catch.
    expect(occurrences(bothTabs, `padding="${PAD.control}"`)).toBe(2);
  });

  it("marks the current tab with an indicator that takes space either way", () => {
    // Every tab carries the indicator; only its colour changes. An indicator rendered
    // solely on the selected tab is the same twitch in a different place.
    expect(occurrences(bothTabs, "height:3px")).toBe(2);
    expect(occurrences(bothTabs, "background:currentColor")).toBe(1);
    expect(occurrences(bothTabs, "background:transparent")).toBe(1);
  });

  it("does not draw the indicator in a colour Polaris cannot make dark", () => {
    // This is the one place the component leaves the design system, and it is load-bearing
    // rather than lazy: the indicator was `background="strong"` on an `s-box` first, which
    // is the most intense background Polaris offers and renders around #ebebeb. Against
    // the admin's grey page it was invisible -- the bar shipped to a browser with no
    // selected tab at all, and every assertion above still passed.
    expect(bar, "the indicator has to be a colour, not a Polaris background token").toContain(
      "currentColor",
    );
    expect(bar).not.toMatch(/blockSize="3px"[\s\S]{0,80}background=\{/);
  });

  it("does not leave the browser to paint the tabs it did not select", () => {
    // The non-current tab is a react-router `Link`, which renders a bare anchor -- and a
    // bare anchor is blue and underlined whatever the Polaris element inside it says,
    // because text-decoration is drawn by the ancestor that set it. "List" as a grey pill
    // beside a browser-blue "Calendar" is what this looked like in production.
    expect(bothTabs).toMatch(/<a[^>]*style="[^"]*text-decoration:\s*none/);
  });

  it("puts the page action in the same row as the tabs", () => {
    // Not in a card above them. The campaigns index had one holding a single button, and
    // an almost-empty card reads as a mistake rather than as a header.
    const withAction = render(
      [{ label: "List", href: "?view=list", current: true }],
      <s-button variant="primary" href="/app/campaigns/new">
        Create campaign
      </s-button>,
    );

    expect(withAction).toContain("Create campaign");
    expect(
      withAction.indexOf("Create campaign") < withAction.indexOf("<s-divider"),
      "the action belongs above the rule, inside the bar",
    ).toBe(true);
  });

  it("keeps a same-page tab switch from jumping to the top", () => {
    // The campaign tabs swap a panel on one route. Resetting scroll there throws away
    // where the merchant was reading; on a real page change it is what they expect,
    // which is why this is the caller's decision and not a constant.
    expect(bar).toContain("preventScrollReset = false");
    const campaign = sourceOf("app/components/campaign/CampaignTabs.tsx");
    expect(campaign).toContain("preventScrollReset");
  });
});

describe("the rule under the row", () => {
  it("is one divider, not a guess at Polaris' border shorthand", () => {
    // The bar used to draw its rule with `borderWidth="none none base none"`. Polaris
    // documents its four-value order as `block-start block-end inline-start inline-end`
    // -- not CSS's clock order, which the comment above it assumed -- so that value is a
    // coin flip between the rule it was meant to be and a stray vertical line down the
    // left of every tab bar in the app. Either way it reads as a rendering artefact
    // rather than as a mistake, which is why it survived from P7.6.
    //
    // `s-divider` is one element that means one thing in one direction.
    expect(bar).toContain("<s-divider />");
    expect(bar, "no four-value edge shorthand, in any order").not.toMatch(
      /borderWidth="\w[\w-]* \w[\w-]* \w[\w-]* \w[\w-]*"/,
    );
  });

  it("sits directly under the tabs, with the indicator touching it", () => {
    // A gap between the tabs and the line makes the line a divider between two unrelated
    // things. The indicator and the divider have to be adjacent for the selected tab to
    // read as part of the rule rather than as floating above it.
    const between = bothTabs.slice(
      bothTabs.lastIndexOf("height:3px"),
      bothTabs.indexOf("<s-divider"),
    );

    expect(between, "nothing may be laid out between the indicator and the rule").not.toMatch(
      /padding|gap=/,
    );
  });

  it("uses the two-value form only where both axes are meant", () => {
    // `PAD.control` is "small-100 base": two values means `block inline`, so the tab is
    // tighter vertically than horizontally. That one is correct and worth not breaking.
    const spacing = sourceOf("app/lib/ui/spacing.ts");
    expect(spacing).toContain('control: "small-100 base"');
  });
});
