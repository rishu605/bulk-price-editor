/**
 * One decision over the whole filtered drift queue (#822), as the page renders it.
 *
 * Two things are load-bearing. Each button names the count it covers, and each dialog
 * names the campaign and the count before anything changes -- the acceptance criterion
 * the queue was reopened for. And a filtered set spanning several campaigns offers no
 * decision at all, but says what to do: a hold is per campaign, and so is a put-back's run.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DriftBulkActions, DriftBulkConfirmations, type BulkTarget } from "./DriftBulk";

const target: BulkTarget = {
  campaign: { id: "c1", name: "QA · perf", status: "HELD" },
  count: 1113,
  waiting: 1200,
  filters: "lowered below the campaign's price",
};

describe("deciding the filtered set at once", () => {
  it("offers the three decisions, each naming the count", () => {
    const html = renderToStaticMarkup(<DriftBulkActions target={target} campaigns={1} busy={false} />);
    expect(html).toContain("Keep all 1,113 changes");
    expect(html).toContain("Put all 1,113 back");
    expect(html).toContain("Leave all 1,113 for now");
    expect(html).toContain("QA · perf");
    // "Keep" is the consequential one, as on each row.
    expect(html.match(/tone="critical"/g)).toHaveLength(1);
  });

  it("asks first, naming the campaign, the count and the filters", () => {
    const html = renderToStaticMarkup(<DriftBulkConfirmations target={target} busy={false} onConfirm={() => {}} />);
    expect(html.match(/<s-modal/g)).toHaveLength(3);
    expect(html).toContain('heading="Put all 1,113 back?"');
    expect(html).toContain("1,113 of the 1,200 waiting for it");
    expect(html).toContain("lowered below the campaign&#x27;s price");
    expect(html).toContain("in one run");
    expect(html).toContain("one entry, with every variant it covers");
  });

  it("offers nothing across several campaigns, and says how to narrow it", () => {
    const html = renderToStaticMarkup(<DriftBulkActions target={null} campaigns={3} busy={false} />);
    expect(html).not.toContain("<s-button");
    expect(html).toContain("These prices belong to 3 campaigns. Choose one under Campaign");
    expect(renderToStaticMarkup(<DriftBulkActions target={null} campaigns={1} busy={false} />)).toBe("");
  });
});
