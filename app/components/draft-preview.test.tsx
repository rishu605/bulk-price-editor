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
  staleBaselines: 0,
  withoutBaseline: 0,
  leftOutByStatus: 0,
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

  it("explains what a live price means, once, above the table", () => {
    const html = render(preview({ rows: [row({ live: "$28.00" }), row()] }));

    expect(html).toContain("either another campaign is pricing them");
    expect(html).toContain("/app/prices/drift");
  });

  it("does not claim which of the two reasons it is", () => {
    // The resolver gave this row to *this* draft, so it does not know who priced the
    // variant last. Naming a cause per row would be a guess.
    const html = render(preview({ rows: [row({ live: "$28.00" })] }));

    expect(html).toContain("either");
  });

  it("says none of that when nothing has drifted", () => {
    expect(render(preview())).not.toContain("/app/prices/drift");
  });

  it("stays quiet when they agree", () => {
    // The ordinary case. A second identical number in every row teaches a merchant to
    // ignore the column, and then it is not read on the day it matters.
    // Words only: the panel's live region carries `aria-live` in its markup (#798), and
    // that is an attribute, not a "live" a merchant reads.
    expect(render(preview()).replace(/<[^>]+>/g, " ")).not.toMatch(/\blive\b/);
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

  it("says the catalogue has not been read, not that the conditions match nothing (#800)", () => {
    // Every filter blank on a store that has never synced: there is no condition to loosen.
    const html = render(preview({ matched: 0, changing: 0, rows: [], catalogue: "unsynced" }));

    expect(html).toContain("Anchor hasn&#x27;t read your catalogue yet");
    expect(html).toContain('href="/app"');
    expect(html).not.toContain("Nothing matches this scope");
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
      preview({
        blocked: {
          reason: "below-floor",
          variantGid: "gid://shopify/ProductVariant/9",
          message: `A guardrail set to block the whole campaign would stop it before anything is written: "Gloves · L" would be $0.33, under its $10.00 floor.`,
        },
      }),
    );

    // The service's sentence, as it wrote it (#1076): never the raw id or the code.
    expect(html).toContain("would stop it before anything is written");
    expect(html).toContain("Gloves · L");
    expect(html).not.toContain("gid://");
    expect(html).not.toContain("below-floor");
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

describe("prices changed outside a campaign (#745)", () => {
  it("says so before Apply, naming what the sale would do to them", () => {
    const html = render(preview({ staleBaselines: 2 }));
    expect(html).toContain("2 of the prices this would change were changed outside this app");
    expect(html).toContain("discount from the old price, and ending it would put the old price back");
    expect(html).toContain('href="/app/prices/baselines/recapture?segment=stale"');
  });

  it("says nothing when there are none", () => {
    const html = render(preview());
    expect(html).not.toContain("outside this app while no");
  });
});

describe("draft and archived products left out (#751)", () => {
  it("says the conditions matched only draft or archived products, and where to include them", () => {
    // The walk that found #751: one title, whose product is archived. "Nothing matches"
    // would send the merchant to loosen a scope that is right.
    const html = render(preview({ matched: 0, changing: 0, rows: [], leftOutByStatus: 2 }));

    expect(html).toContain("Only draft or archived products match");
    expect(html).toContain("2 variants on draft or archived products are left out.");
    expect(html).toContain("Include draft products");
    expect(html).not.toContain("Nothing matches this scope");
  });

  it("names the ones left out beside the counts", () => {
    const html = render(preview({ leftOutByStatus: 1 }));
    expect(html).toContain("1 variant on a draft or archived product is left out.");
  });

  it("says nothing when none are", () => {
    const html = render(preview());
    expect(html).not.toContain("left out");
  });
});
