/**
 * What a page says when it has no rows, and the two situations it must not confuse.
 *
 * `EmptyState` existed and one page called it. Everywhere else the same moment was a bare
 * `s-paragraph` flush against the control above it — which is the exact shape that
 * component's own doc comment says it exists to prevent, because a title and one sentence
 * left-aligned at the top of a card read as the beginning of content that did not arrive.
 *
 * The distinction worth testing is the other one. A shop with no variants and a shop
 * whose filter matched nothing need opposite things: the first needs telling what a
 * variant is, the second needs the filter taken off. Six pages said "nothing matches" and
 * offered no way to stop matching nothing, so `NoMatches` cannot be called without
 * saying where Clear filters goes — and that is what the last block here checks, on every
 * empty branch in the app rather than on the ones somebody remembered.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router";
import { describe, expect, it } from "vitest";

import { sourceOf } from "../lib/testing/source";

import { EmptyState, NoMatches } from "./AsyncState";
import { clearedSearch } from "./FilterForm";
import { CampaignListView } from "./campaign/CampaignListView";

const render = (node: React.ReactElement) =>
  renderToStaticMarkup(<StaticRouter location="/app/prices">{node}</StaticRouter>);

describe("an empty state is an answer, not a missing table", () => {
  it("gives the words room, so it does not read as a render that failed", () => {
    const html = render(<EmptyState title="No baselines captured yet" />);

    expect(html).toContain("No baselines captured yet");
    // Block padding: the words have to sit in space that was obviously left for them.
    expect(html).toMatch(/paddingblock="large-200"/i);
  });

  it("sits on the card's own left edge rather than in the middle of it", () => {
    // Centring is right for a full-page empty state standing on its own. Inside a card
    // whose heading is hard left two inches above it, a centred block reads as a
    // different component that has wandered in — which is how Diagnostics looked, and
    // Variants, Baselines, Campaigns, Segments, Activity and Price drift with it.
    const html = render(<EmptyState title="No baselines captured yet" />);

    expect(html).not.toMatch(/alignitems="center"/i);
  });

  it("caps the measure of its body copy", () => {
    // The card's measure, shared with its prose and its fields, rather than a number of
    // this component's own — see `MEASURE`.
    const html = render(<EmptyState title="No variants yet" description={"a ".repeat(200)} />);

    expect(html).toMatch(/maxinlinesize="\d+px"/i);
  });

  it("renders a way out only when there is one", () => {
    expect(render(<EmptyState title="No drift detected" />)).not.toContain("<s-button");
    expect(
      render(<EmptyState title="No variants yet" action={{ label: "Sync", href: "/app" }} />),
    ).toContain('href="/app"');
  });
});

describe("empty because of a filter is a different thing, and always offers the way back", () => {
  const html = render(<NoMatches noun="campaigns" clearHref="?status=" />);

  it("names what is missing rather than saying 'nothing matches'", () => {
    expect(html).toContain("No campaigns match those filters");
  });

  it("always offers to clear the filters", () => {
    expect(html).toContain("Clear filters");
    expect(html).toContain('href="?status="');
  });

  it("keeps Clear filters secondary, so it does not compete with the page's own action", () => {
    expect(html).not.toContain('variant="primary"');
  });
});

describe("the campaigns index picks the right one of the two", () => {
  const list = (campaigns: unknown[]) => ({
    campaigns: campaigns as never,
    total: campaigns.length,
    attentionCount: 0,
    page: 1,
    pages: 1,
  });

  const view = (filters: { q: string; status: string }) =>
    renderToStaticMarkup(
      <StaticRouter location="/app/campaigns">
        <CampaignListView
          list={list([])}
          filters={{ ...filters, archived: false, page: 1 }}
          linkTo={(next) => `?${new URLSearchParams(next)}`}
          // A plain element in place of the router's Form, the same stand-in the campaign
          // header's tests use: this renders to static markup, and a real fetcher needs a
          // data router the assertions here have no use for.
          fetcher={{ Form: "form" } as never}
        />
      </StaticRouter>,
    );

  it("explains what a campaign is when the shop has none", () => {
    const html = view({ q: "", status: "" });

    expect(html).toContain("No campaigns yet");
    expect(html).toContain("20% off this collection");
    expect(html).not.toContain("Clear filters");
  });

  it("offers to clear the filters when a filter is what emptied it", () => {
    const html = view({ q: "", status: "DRAFT" });

    expect(html).toContain("No campaigns match those filters");
    expect(html).toContain("Clear filters");
  });

  it("counts a search as a filter, not only a status", () => {
    expect(view({ q: "summer", status: "" })).toContain("Clear filters");
  });

  it("no longer carries a second EmptyState of its own", () => {
    const source = sourceOf("app/components/campaign/CampaignListView.tsx");

    expect(source).not.toMatch(/function EmptyState/);
  });
});

describe("clearing a filter keeps the parameters App Bridge needs", () => {
  const params = () =>
    new URLSearchParams("host=abc&id_token=xyz&shop=s.myshopify.com&q=tee&vendor=Acme&page=4");

  it("removes only the fields the form owns", () => {
    const next = new URLSearchParams(clearedSearch(params(), ["q", "vendor"]));

    expect(next.get("q")).toBeNull();
    expect(next.get("vendor")).toBeNull();
    expect(next.get("host")).toBe("abc");
    expect(next.get("id_token")).toBe("xyz");
    expect(next.get("shop")).toBe("s.myshopify.com");
  });

  it("drops the page, because page four of the old filter means nothing without it", () => {
    expect(new URLSearchParams(clearedSearch(params(), ["q"])).get("page")).toBeNull();
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

describe("no page answers 'where are my rows' with a loose paragraph", () => {
  /**
   * Both spellings of the empty branch: the ternary a route renders inline, and the
   * early return a table component takes before it renders a header row.
   */
  const BRANCHES = [
    // `(?:[\w.]+\s*\?\s*\(\s*)*` steps over the inner ternaries that pick between the
    // states. Without it a page that got this *right* — one state when a filter emptied
    // it, another when there was never anything — is the one the check cannot see. The
    // dot is in the class because the condition is as likely to be `filters.archived` as
    // a bare name, and a check that stops seeing a branch the moment its condition lives
    // on an object is a check that rewards the wrong refactor.
    /(\w+)(?:\.length)? === 0\s*\?\s*\(\s*(?:[\w.]+\s*\?\s*\(\s*)*(<[A-Za-z][\w.-]*)/g,
    /(\w+)(?:\.length)? === 0\)\s*\{\s*return\s*\(\s*(<[A-Za-z][\w.-]*)/g,
  ];

  /**
   * Collections that are not rows.
   *
   * `PageShell` branches on `aside.length === 0` to choose between a one-column and a
   * two-column page. It is the same expression and a completely different question, and
   * an empty state there would be a heading announcing that a page has no sidebar.
   */
  const NOT_DATA = ["aside"];

  /**
   * `<Blank />` is a cell with nothing in it, not a page with no rows.
   *
   * "This segment is used by no campaigns" is a true statement about one row that
   * exists — answering it with a centred heading and a call to action would be a page
   * announcing its own emptiness inside a table cell.
   */
  const ALLOWED = ["<EmptyState", "<NoMatches", "<>", "<Blank"];

  /** Rendered outside the embedded admin, with their own CSS and no Polaris. */
  const OUTSIDE_THE_ADMIN = ["routes/help.$", "routes/_index"];

  /**
   * Not a page reporting that it has no rows.
   *
   * `DraftPreview` is the panel beside the rule in the campaign editor, and it re-renders
   * on a debounce while the merchant is typing. "Nothing matches this scope yet" there is
   * a hint under a control, not an answer to "where are my rows" — and a centred empty
   * state with `large-200` block padding would shove the rest of the form down and back
   * up again on the way to a rule that matches something.
   */
  const NOT_A_PAGE = ["components/DraftPreview.tsx"];

  const admin = tsxFiles(APP).filter(
    (path) => ![...OUTSIDE_THE_ADMIN, ...NOT_A_PAGE].some((skip) => path.includes(skip)),
  );


  const offenders = admin.flatMap((path) => {
    const source = sourceOf(path);
    return BRANCHES.flatMap((pattern) =>
      [...source.matchAll(pattern)]
        .filter((match) => !NOT_DATA.includes(match[1]) && !ALLOWED.includes(match[2]))
        .map((match) => `${path.replace(`${APP}/`, "")}: ${match[2]}`),
    );
  });

  it("finds the empty branches to check", () => {
    const found = admin.flatMap((path) => {
      const source = sourceOf(path);
      return BRANCHES.flatMap((pattern) =>
        [...source.matchAll(pattern)].filter((match) => !NOT_DATA.includes(match[1])),
      );
    });

    expect(found.length).toBeGreaterThanOrEqual(11);
  });

  it("renders an empty state in every one of them", () => {
    expect(
      offenders,
      "these open their no-rows branch with something other than EmptyState or NoMatches",
    ).toEqual([]);
  });
});
