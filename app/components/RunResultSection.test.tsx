/**
 * The result section, rendered.
 *
 * The Shopify admin embeds this app in a cross-origin iframe that synthetic scrolling
 * cannot reach, so "look at it in the browser" stops at whatever fits in one viewport.
 * Rendering it here is the part that can actually be checked every time: that the honest
 * sentence reaches the page, that the counts a merchant acts on are shown, and that a
 * partial run does not render as a success.
 *
 * Server rendering rather than a DOM: Polaris web components are custom elements the
 * server does not need to understand, and their attributes come through as written —
 * which is exactly what needs asserting about `tone`.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { RunResultSection } from "./RunResultSection";
import type { CampaignResult } from "../services/campaigns/result.server";

function result(over: Partial<CampaignResult> = {}): CampaignResult {
  return {
    runId: "run_1",
    clean: true,
    summary: "4 prices changed and verified.",
    counts: {
      verified: 4,
      unverified: 0,
      clamped: 0,
      skipped: 0,
      failed: 0,
      reverted: 0,
      pending: 0,
      total: 4,
    },
    margin: {
      covered: 4,
      unknown: 0,
      averageBefore: 50,
      averageAfter: 37.5,
      averageDelta: 12.5,
      belowTarget: [],
      belowCost: [],
    },
    marginCoveredRows: null,
    unavailable: "Units sold and revenue are not shown.",
    ...over,
  };
}

const render = (value: CampaignResult) => renderToStaticMarkup(<RunResultSection result={value} />);

describe("a clean run", () => {
  const html = render(result());

  it("leads with the summary sentence", () => {
    expect(html).toContain("4 prices changed and verified.");
  });

  it("is toned as a success", () => {
    expect(html).toMatch(/<s-banner[^>]*tone="success"/);
  });

  it("shows the margin movement and says it covered everything", () => {
    expect(html).toContain("50.0%");
    expect(html).toContain("37.5%");
    expect(html).toContain("across all 4 products");
  });

  it("still says what it cannot tell you", () => {
    // An empty panel where revenue would go reads as a bug; naming the gap does not.
    expect(html).toContain("Units sold and revenue are not shown.");
  });
});

describe("a run that did not finish", () => {
  const partial = result({
    clean: false,
    summary: "2 rows failed. 2 prices changed and verified.",
    counts: { ...result().counts, verified: 2, failed: 2, total: 4 },
  });

  it("is toned critically, not neutrally", () => {
    // A partial run rendered as a success is the failure this product exists to prevent.
    expect(render(partial)).toMatch(/<s-banner[^>]*tone="critical"/);
  });

  it("shows the failure count", () => {
    expect(render(partial)).toContain("Failed");
  });

  it("warns rather than celebrates when rows are merely unverified", () => {
    const unverified = result({
      clean: false,
      summary: "2 were written but not read back. 2 prices changed and verified.",
      counts: { ...result().counts, verified: 2, unverified: 2, total: 4 },
    });

    const html = render(unverified);
    expect(html).toMatch(/<s-banner[^>]*tone="warning"/);
    expect(html).toContain("Not read back");
  });
});

describe("what it says when it knows less", () => {
  it("names the products it could not price rather than averaging over them", () => {
    const html = render(
      result({ margin: { ...result().margin, covered: 3, unknown: 7 } }),
    );

    expect(html).toContain("3 products that have a cost");
    expect(html).toContain("7 do not");
  });

  it("says nothing at all when no product has a cost", () => {
    const html = render(
      result({
        margin: { ...result().margin, covered: 0, unknown: 4, averageBefore: 0, averageAfter: 0 },
      }),
    );

    expect(html).toContain("none of the products this run changed has a cost recorded");
    // And no invented 0% margin.
    expect(html).not.toContain("0.0%");
  });

  it("admits when the margin figures cover only part of the run", () => {
    // A cap that stays quiet reads as "we measured the whole campaign".
    const html = render(
      result({
        marginCoveredRows: 50_000,
        counts: { ...result().counts, verified: 120_000, total: 120_000 },
      }),
    );

    expect(html).toContain("50,000");
    expect(html).toContain("120,000");
  });
});

describe("naming the products that went wrong", () => {
  it("lists the ones now below cost", () => {
    const html = render(
      result({
        margin: {
          ...result().margin,
          belowCost: [
            { variantGid: "gid://v/1", title: "Whiteout Jacket", before: 40, after: -5, delta: 45 },
          ],
        },
      }),
    );

    expect(html).toContain("Whiteout Jacket");
    expect(html).toContain("-5.0% margin");
    expect(html).toMatch(/<s-banner[^>]*tone="critical"/);
  });
});
