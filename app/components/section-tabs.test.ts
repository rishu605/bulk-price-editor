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

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const tabs = readFileSync(
  join(process.cwd(), "app", "components", "SectionTabs.tsx"),
  "utf8",
);
const layout = readFileSync(
  join(process.cwd(), "app", "routes", "app.prices.tsx"),
  "utf8",
);
const search = readFileSync(
  join(process.cwd(), "app", "components", "prices", "VariantSearch.tsx"),
  "utf8",
);

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
    // `startsWith` here would light up Variants on every page in the section.
    expect(tabs).toContain("pathname === tab.href");
    expect(tabs).not.toContain("pathname.startsWith");
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
    expect(tabs).toContain("tab.badge ? `${tab.label} (${tab.badge})` : tab.label");
  });
});

describe("the tab bar's semantics", () => {
  it("is a navigation landmark, not loose links in the page body", () => {
    // Polaris has no tabs element and `accessibilityRole` offers no `tablist`, so this
    // is the correct role that is actually available — and it is the right one anyway:
    // these move between URLs, where ARIA tabs are for switching panels within a page.
    expect(tabs).toContain('accessibilityRole="navigation"');
    expect(tabs).toContain("accessibilityLabel=");
  });

  it("tells a screen reader which tab is current, not only the eye", () => {
    // The filled pill says it to everyone who can see it and nothing to anyone who
    // cannot.
    expect(tabs).toContain('accessibilityVisibility="exclusive"');
    expect(tabs).toMatch(/current section/i);
  });

  it("does not link the tab you are already on", () => {
    // A link to the page you are on is a control that does nothing.
    const currentBranch = tabs.slice(tabs.indexOf("current ?"), tabs.indexOf(") : ("));
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
