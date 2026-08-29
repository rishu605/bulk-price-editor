/**
 * The campaigns list, and the two shapes Polaris can render it in.
 *
 * `s-table` decides for itself whether to draw a grid or stack each row into key-value
 * pairs, and App Home's `variant` only offers `auto` and `list` — there is no way to pin
 * the grid. At this column's width the two are close enough together that the same page
 * renders both ways on consecutive reloads, which is Polaris' call and not one the app
 * can override.
 *
 * So the thing worth testing is not *which* shape appears. It is that both are shapes
 * somebody chose: every header says what it becomes when the table collapses, because the
 * default (`labeled`) turns three campaigns into fifteen "Priority 900" rows with the
 * campaign's own name carrying no more weight than its priority.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router";
import { describe, expect, it } from "vitest";

import { CampaignListView } from "./CampaignListView";
import { describeState } from "../../lib/lifecycle/transitions";
import { describeRule, describeScope } from "../../lib/campaigns/describe";

type Props = Parameters<typeof CampaignListView>[0];

const campaign = (over: Partial<Props["list"]["campaigns"][number]> = {}) => ({
  id: "c1",
  name: "Guardrail live",
  state: "ACTIVE" as const,
  // The real describer, not a hand-written stand-in: a fixture that invents its own
  // shape stops catching the day the real one grows a field.
  lifecycle: describeState("ACTIVE"),
  attention: false,
  priority: 900,
  // Through the real formatter, for the same reason `lifecycle` is: a fixture that
  // writes its own sentence stops catching the day the real one changes.
  rule: describeRule({ kind: "percent-change", percent: -20 }),
  scope: describeScope({ groups: [{ conditions: [{ field: "tag", value: "sale" }] }] }),
  note: null,
  archived: false,
  createdAt: "2026-08-01T00:00:00.000Z",
  lastRun: null,
  ...over,
});

const list = (over: Partial<Props["list"]> = {}): Props["list"] => ({
  campaigns: [campaign()],
  total: 1,
  attentionCount: 0,
  page: 1,
  pages: 1,
  ...over,
});

const render = (over: Partial<Props> = {}) =>
  renderToStaticMarkup(
    <StaticRouter location="/app/campaigns">
      <CampaignListView
        list={over.list ?? list()}
        filters={over.filters ?? { q: "", status: "", archived: false, page: 1 }}
        linkTo={(next) => `?${new URLSearchParams(next)}`}
        // A plain element in place of the router's Form, the same stand-in the campaign
        // header's tests use: this renders to static markup, and a real fetcher needs a
        // data router the assertions here have no use for.
        fetcher={{ Form: "form" } as never}
      />
    </StaticRouter>,
  );

describe("the table survives being collapsed into a list", () => {
  const html = render();

  it("names exactly one column as the row's title", () => {
    // Without a primary, every column is a labelled pair and the campaign's name reads
    // as one row of five rather than as the thing the row is about.
    expect(html.split('listSlot="primary"').length - 1).toBe(1);
    const primary = html.slice(html.indexOf('listSlot="primary"'));
    expect(primary.slice(0, 60)).toContain("Campaign");
  });

  it("designates every other column too, so none falls back to a default", () => {
    const headers = [...html.matchAll(/<s-table-header(\s[^>]*)?>/g)];
    expect(headers.length, "seven columns, the last one the action").toBe(7);

    for (const [tag] of headers) {
      expect(tag, `${tag} has no list designation`).toContain("listSlot=");
    }
  });

  it("keeps the status, the rule and the way in on the row itself", () => {
    // All three `inline`, so a collapsed row reads as one line — "Autumn sale · Active ·
    // 20% off · Open" — and answers what state this is in, what it does, and how to open
    // it without unfolding into a block. The scope is `labeled` because it is longer and
    // reads better stacked under its own word than run on after the rule.
    expect(html.split('listSlot="inline"').length - 1).toBe(3);
  });

  it("says what each campaign does and what to", () => {
    // The gap this table had: everything *about* a campaign and nothing about what it is.
    expect(html).toContain("20% off");
    expect(html).toContain("Tagged sale");
  });

  it("treats the priority as a number", () => {
    // Right-aligns it in the grid. It is a rank, not a label.
    expect(html).toContain('format="numeric"');
  });
});

describe("when there is nothing to list", () => {
  it("explains what a campaign is to a shop that has none", () => {
    const html = render({ list: list({ campaigns: [], total: 0 }) });

    expect(html).toContain("No campaigns yet");
    expect(html).toMatch(/Nothing is written to your storefront/);
    // Nothing to clear, so offering it would be a control that does nothing.
    expect(html).not.toContain("Clear filters");
  });

  it("offers a way out when it is the filters that match nothing", () => {
    // This used to be a sentence telling the merchant to clear the filters, with no
    // control to do it.
    const html = render({
      list: list({ campaigns: [], total: 0 }),
      filters: { q: "nothing", status: "DRAFT", archived: false, page: 1 },
    });

    expect(html).toContain("No campaigns match those filters");
    expect(html).toContain("Clear filters");
  });
});
