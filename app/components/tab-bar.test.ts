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

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const bar = readFileSync(join(ROOT, "app/components/TabBar.tsx"), "utf8");

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
  source: readFileSync(join(ROOT, path), "utf8"),
}));

describe("every set of tabs uses the shared bar", () => {
  it.each([
    "app/components/SectionTabs.tsx",
    "app/components/campaign/CampaignTabs.tsx",
    "app/routes/app.campaigns._index.tsx",
  ])("%s renders TabBar rather than its own row", (path) => {
    const source = files.find((file) => file.path === path)?.source ?? "";
    expect(source, `${path} should be a known tab surface`).not.toBe("");
    expect(source).toMatch(/import \{ TabBar \} from/);
  });

  it("finds no fourth implementation", () => {
    // A tab bar is a navigation landmark. The app's own sections are the only navigation
    // this app renders -- everything else is Shopify's chrome -- so a second file
    // claiming the role is a second bar, whatever it is called.
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
    // Both branches carry `padding`, current and not. Padding only the selected one
    // moves every other tab sideways on each click.
    const current = bar.slice(bar.indexOf("tab.current ?"), bar.indexOf(") : ("));
    const other = bar.slice(bar.indexOf(") : ("));

    expect(current).toContain("padding={PAD.control}");
    expect(other).toContain("padding={PAD.control}");
  });

  it("keeps a same-page tab switch from jumping to the top", () => {
    // The campaign tabs swap a panel on one route. Resetting scroll there throws away
    // where the merchant was reading; on a real page change it is what they expect,
    // which is why this is the caller's decision and not a constant.
    expect(bar).toContain("preventScrollReset = false");
    const campaign = readFileSync(
      join(ROOT, "app/components/campaign/CampaignTabs.tsx"),
      "utf8",
    );
    expect(campaign).toContain("preventScrollReset");
  });
});

describe("the rule under the row", () => {
  it("is on the block-end edge, not the inline-end one", () => {
    // Polaris edge shorthands run `block-start inline-end block-end inline-start` --
    // CSS clock order, flow-relative. Getting it wrong draws a vertical line down the
    // side of the page, which reads as a rendering artefact rather than as a mistake,
    // so it shipped from P7.6 until someone looked at a zoomed screenshot.
    expect(bar).toContain('borderWidth="none none base none"');
    expect(bar, "second position is inline-end -- the right-hand edge").not.toContain(
      'borderWidth="none base none none"',
    );
  });

  it("uses the two-value form only where both axes are meant", () => {
    // `PAD.control` is "small-100 base": two values means `block inline`, so the pill is
    // tighter vertically than horizontally. That one is correct and worth not breaking.
    const spacing = readFileSync(join(ROOT, "app/lib/ui/spacing.ts"), "utf8");
    expect(spacing).toContain('control: "small-100 base"');
  });
});
