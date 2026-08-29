/**
 * The prices tabs, and the filter that has to survive them.
 *
 * Five views of the same variant rows. Searching for a SKU in Baselines and switching to
 * What's live is a merchant asking about *that SKU* — not asking to start again. Dropping
 * the query on a tab switch is the small betrayal that teaches people to distrust a
 * filter, and it is invisible in a screenshot.
 *
 * `page` is the exception: page 4 of the baselines is not page 4 of drift, and landing
 * on an empty page reads as "nothing here" rather than "wrong page".
 */


import { describe, expect, it } from "vitest";

import { sourceOf } from "../lib/testing/source";

import { isCurrent } from "./SectionTabs";

const tabs = sourceOf(process.cwd(), "app", "components", "SectionTabs.tsx");
// The bar itself is shared with the campaign page and the campaigns index. What stays
// in SectionTabs is only what is specific to sections: the query string, and what
// "current" means when the tabs are separate routes.
const bar = sourceOf(process.cwd(), "app", "components", "TabBar.tsx");
const layout = sourceOf(process.cwd(), "app", "routes", "app.prices.tsx");
const search = sourceOf(process.cwd(), "app", "components", "prices", "VariantSearch.tsx");

describe("filters survive a tab switch", () => {
  it("carries the query string onto every tab link", () => {
    expect(tabs).toContain("new URLSearchParams(params)");
    expect(tabs).toMatch(/query \? `\$\{tab\.href\}\?\$\{query\}` : tab\.href/);
  });

  it("drops the page number, which does not transfer between tabs", () => {
    expect(tabs).toContain('carried.delete("page")');
  });
});

describe("the current tab", () => {
  it("matches exactly, because /app/prices prefixes every other tab", () => {
    // The rule this replaced was a bare `pathname === tab.href`, which was right until a
    // tab grew a page beneath it: `/app/prices/baselines/recapture` lit up nothing at
    // all, which is the bug `/app/imports` had. `isCurrent` is exercised directly below
    // rather than checked for the absence of a `startsWith`, because the interesting part
    // is now which prefixes are allowed.
    expect(tabs).toContain("isCurrent(pathname, tab.href, tabs)");
  });
});

describe("which tab is the one you are on", () => {
  const PRICES = [
    { href: "/app/prices" },
    { href: "/app/prices/baselines" },
    { href: "/app/prices/costs" },
  ];

  it("marks the tab whose page you are on", () => {
    expect(isCurrent("/app/prices/baselines", "/app/prices/baselines", PRICES)).toBe(true);
    expect(isCurrent("/app/prices/baselines", "/app/prices/costs", PRICES)).toBe(false);
  });

  it("marks a tab you are on a page beneath", () => {
    // Recapture is reached from Baselines and is about what Baselines lists. A bar with
    // nothing selected is what `/app/imports` used to do, and there was no way back.
    expect(isCurrent("/app/prices/baselines/recapture", "/app/prices/baselines", PRICES)).toBe(
      true,
    );
  });

  it("never marks the section root from a prefix, which is every page in the section", () => {
    // `/app/prices` is a prefix of every tab under it. This is the whole reason the
    // original rule was exact, and the reason the exception has to exclude the root.
    expect(isCurrent("/app/prices/baselines", "/app/prices", PRICES)).toBe(false);
    expect(isCurrent("/app/prices/costs", "/app/prices", PRICES)).toBe(false);
    expect(isCurrent("/app/prices", "/app/prices", PRICES)).toBe(true);
  });

  it("finds the root by what it is a prefix of, not by where it sits in the list", () => {
    const reordered = [...PRICES].reverse();
    expect(isCurrent("/app/prices/costs", "/app/prices", reordered)).toBe(false);
  });

  it("does not match a sibling that merely starts with the same letters", () => {
    const tabs = [{ href: "/app/prices" }, { href: "/app/prices/base" }];
    expect(isCurrent("/app/prices/baselines", "/app/prices/base", tabs)).toBe(false);
  });
});

describe("drift is countable without being opened", () => {
  it("counts what the drift tab itself lists", () => {
    // A badge that disagrees with the page it points at is worse than no badge.
    expect(layout).toContain('resolution: "PENDING"');
  });

  it("puts the count on the tab", () => {
    expect(layout).toMatch(/label: "Drift", badge: drifted/);
  });

  it("shows nothing at zero, since an empty count is noise", () => {
    expect(bar).toContain("tab.badge ? `${tab.label} (${tab.badge})` : tab.label");
  });
});

describe("the tab bar's semantics", () => {
  it("is a navigation landmark, not loose links in the page body", () => {
    // Polaris has no tabs element and `accessibilityRole` offers no `tablist`, so this
    // is the correct role that is actually available — and it is the right one anyway:
    // these move between URLs, where ARIA tabs are for switching panels within a page.
    expect(bar).toContain('accessibilityRole="navigation"');
    expect(bar).toContain("accessibilityLabel=");
  });

  it("tells a screen reader which tab is current, not only the eye", () => {
    // The filled pill says it to everyone who can see it and nothing to anyone who
    // cannot.
    expect(bar).toContain('accessibilityVisibility="exclusive"');
    expect(bar).toMatch(/\(current\)/i);
  });

  it("does not link the tab you are already on", () => {
    // A link to the page you are on is a control that does nothing.
    const currentBranch = bar.slice(bar.indexOf("tab.current ?"), bar.indexOf(") : ("));
    expect(currentBranch).not.toContain("<Link");
  });
});

describe("search on an embedded surface", () => {
  it("never uses a native form element", () => {
    // A plain GET submit replaces the whole query string, including the host and
    // id_token App Bridge put there, and the merchant gets a blank page.
    expect(search).toContain("FilterForm");
    expect(search).not.toMatch(/<form[\s>]/);
  });

  it("uses the search field Polaris provides rather than a text box", () => {
    expect(search).toContain("<s-search-field");
  });
});
