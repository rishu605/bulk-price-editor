/**
 * The panel that answers "what would this rule do".
 *
 * Rendered to static markup rather than driven in a DOM, for the reason `vitest.config.ts`
 * gives: the admin embeds this app in a cross-origin iframe that synthetic input cannot
 * reach, so "check it in the browser" stops at what the server sent.
 *
 * What is being defended here is a claim, not a layout. Every competitor computes a
 * relative change against the live storefront price; ours computes it from a captured
 * baseline, which is why RUBIX's own FAQ has to explain that a 30% sale followed by a 50%
 * sale leaves a product at 35% of its original price for ever. A column headed "Now"
 * would describe their arithmetic. The header, and the line that appears when the two
 * disagree, are that claim made visible.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DraftPreview } from "./DraftPreview";
import type { DraftPreview as Preview, DraftPreviewRow } from "../services/campaigns/draft-preview.server";

const row = (over: Partial<DraftPreviewRow> = {}): DraftPreviewRow => ({
  variantGid: "gid://shopify/ProductVariant/1",
  title: "Cotton tee · M",
  imageUrl: "https://cdn.example/tee.png",
  before: "$40.00",
  live: null,
  after: "$32.00",
  beforeCompareAt: null,
  afterCompareAt: null,
  unchanged: false,
  skippedReason: null,
  ...over,
});

const preview = (over: Partial<Preview> = {}): Preview => ({
  matched: 1,
  changing: 1,
  alreadyCorrect: 0,
  skipped: 0,
  withoutBaseline: 0,
  rows: [row()],
  overlaps: [],
  blocked: null,
  ...over,
});

const render = (value: Preview | null, pending = false) =>
  renderToStaticMarkup(<DraftPreview preview={value} pending={pending} />);

describe("the before column is the baseline", () => {
  it("heads the column with the number the arithmetic starts from", () => {
    const html = render(preview());

    expect(html).toContain("Baseline");
    expect(
      html,
      '"Now" describes a competitor\'s arithmetic, not ours — it is the live price, ' +
        "and a relative rule never reads it",
    ).not.toContain(">Now<");
  });

  it("shows both prices, so the row answers the question on its own", () => {
    const html = render(preview());

    expect(html).toContain("$40.00");
    expect(html).toContain("$32.00");
  });

  it("carries the product's picture, because that is how a merchant recognises it", () => {
    expect(render(preview())).toContain("https://cdn.example/tee.png");
  });

  it("still renders a row for a variant with no photo", () => {
    // A product without an image is ordinary; a broken frame would read as an error the
    // merchant has to go and fix.
    const html = render(preview({ rows: [row({ imageUrl: null })] }));

    expect(html).toContain("Cotton tee");
    expect(html).not.toContain("s-thumbnail");
  });
});

describe("when the storefront disagrees with the baseline", () => {
  it("says what is live, so the merchant knows which number we are working from", () => {
    const html = render(preview({ rows: [row({ live: "$28.00" })] }));

    expect(html).toContain("$28.00");
    expect(html).toContain("live");
  });

  it("stays quiet when they agree", () => {
    // The ordinary case. A second identical number in every row teaches a merchant to
    // ignore the column, and then it is not read on the day it matters.
    expect(render(preview())).not.toContain("live");
  });
});

describe("the states that are not a table", () => {
  it("asks for a rule before there is one", () => {
    expect(render(null)).toContain("Set a rule");
  });

  it("says it is working rather than asking for a rule that is already set", () => {
    // The first thing a merchant reads, for about a second: the panel is asked for on
    // mount, and the form already has a rule in it. "Set a rule" would be wrong on
    // arrival and wrong again on every scope change.
    const html = render(null, true);

    expect(html).toContain("Working out");
    expect(html).not.toContain("Set a rule");
  });

  it("keeps the last answer on screen while a new one is computed", () => {
    // Blanking on every keystroke makes the numbers flicker and leaves nothing to
    // compare the new answer against.
    const html = render(preview(), true);

    expect(html).toContain("$32.00");
    expect(html).toContain("updating");
  });

  it("names the scope as the thing that matched nothing", () => {
    const html = render(preview({ matched: 0, changing: 0, rows: [] }));

    expect(html).toContain("Nothing matches this scope");
    // No Clear filters button: after #442 the scope is form state, not a query string,
    // so there is no URL that clears it and a link would discard the merchant's rule.
    expect(html).not.toContain("Clear filters");
  });

  it("reports a guardrail that would stop the whole run", () => {
    const html = render(
      preview({ blocked: { reason: "below-floor", variantGid: "gid://shopify/ProductVariant/9" } }),
    );

    expect(html).toContain("below your");
    expect(html, "the merchant needs to know nothing at all would be written").toContain(
      "Nothing would",
    );
  });

  it("explains every row that will not move", () => {
    const html = render(
      preview({
        matched: 10,
        changing: 6,
        alreadyCorrect: 2,
        skipped: 1,
        withoutBaseline: 1,
        rows: [row(), row({ skippedReason: "Below your cost floor" })],
      }),
    );

    expect(html).toContain("already at this price");
    expect(html).toContain("left alone");
    expect(html).toContain("no baseline yet");
    expect(html).toContain("Below your cost floor");
  });
});
