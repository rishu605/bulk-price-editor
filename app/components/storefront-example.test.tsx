/**
 * What the customer will see, before anything is written.
 *
 * The table beside this answers "how many, and which?". This answers the question asked
 * first: *did I mean −20% or ×0.20, and is the strike-through going to look right?* NA
 * puts the same card beside its rule and it is the clearest thing in their app; RUBIX
 * does a version of it with invented numbers, which teaches the arithmetic and nothing
 * about the merchant's own shop.
 *
 * Two things here are correctness rather than presentation, and both are asserted:
 *
 * - **A sale badge is a claim.** Rendering one when the compare-at does not exceed the
 *   price tells a merchant their storefront will show a discount that it will not.
 * - **The example must not move while a merchant types.** A card that changes product
 *   between keystrokes cannot be compared against itself, which is the only thing an
 *   example is for.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { exampleRowFrom, StorefrontExample } from "./StorefrontExample";
import type { DraftPreviewRow } from "../services/campaigns/draft-preview.server";

const row = (over: Partial<DraftPreviewRow> = {}): DraftPreviewRow => ({
  variantGid: "gid://shopify/ProductVariant/1",
  title: "Cotton tee · M",
  imageUrl: "https://cdn.example/tee.png",
  before: "$40.00",
  live: null,
  after: "$32.00",
  beforeCompareAt: null,
  afterCompareAt: "$40.00",
  unchanged: false,
  skippedReason: null,
  ...over,
});

const render = (value: DraftPreviewRow, surface?: string) =>
  renderToStaticMarkup(<StorefrontExample row={value} surface={surface} />);

describe("the card a customer would see", () => {
  it("leads with the price they will pay", () => {
    expect(render(row())).toContain("$32.00");
  });

  it("strikes the compare-at through semantically, not with a line only sighted merchants see", () => {
    // Polaris documents `redundant` for exactly this — "no longer accurate… one such
    // use-case is discounted prices" — and renders `<s>`.
    expect(render(row())).toContain('type="redundant"');
  });

  it("says which baseline the price came from", () => {
    expect(render(row())).toContain("baseline of $40.00");
  });

  it("mentions the storefront's own price when it has drifted from the baseline", () => {
    expect(render(row({ live: "$28.00" }))).toContain("storefront currently shows $28.00");
  });

  it("names the surface when the shop has more than one", () => {
    expect(render(row(), "base price · USD")).toContain("base price · USD");
  });

  it("says nothing about surfaces on a shop with one", () => {
    // Narrow, because the variant title has its own separator in it — "Cotton tee · M".
    expect(render(row())).toContain("On your storefront<");
    expect(render(row())).not.toContain("On your storefront ·");
  });
});

describe("a sale badge is a claim about the storefront", () => {
  it("shows one when the compare-at is above the price", () => {
    expect(render(row())).toContain("Sale");
  });

  it("shows none when the campaign leaves the compare-at alone", () => {
    expect(render(row({ afterCompareAt: null }))).not.toContain("Sale");
  });

  it("shows none when the compare-at equals the price", () => {
    // Equal is not a discount. A badge here promises a saving of nothing.
    expect(render(row({ after: "$40.00", afterCompareAt: "$40.00" }))).not.toContain("Sale");
  });
});

describe("choosing the example", () => {
  const changing = row({ variantGid: "changing" });
  const noop = row({ variantGid: "noop", unchanged: true });
  const skipped = row({ variantGid: "skipped", skippedReason: "Below your cost floor" });

  it("picks the first row whose price actually moves", () => {
    expect(exampleRowFrom([noop, skipped, changing])?.variantGid).toBe("changing");
  });

  it("is stable, so the card does not flicker between products while typing", () => {
    const rows = [noop, skipped, changing, row({ variantGid: "second" })];

    expect(exampleRowFrom(rows)).toBe(exampleRowFrom(rows));
    expect(exampleRowFrom(rows)?.variantGid).toBe("changing");
  });

  it("shows nothing when no price moves", () => {
    // An example of a price that is not changing teaches the opposite of the lesson.
    expect(exampleRowFrom([noop, skipped])).toBeNull();
    expect(exampleRowFrom([])).toBeNull();
  });
});
