/**
 * The filter builder as it renders (#817): its one field, every row's control, the picked lists
 * and the count. Rendered to static markup, as the app's other component tests are.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { decodeScope, EMPTY_SCOPE, type ScopeDraft } from "../../lib/segments/scope-builder";
import type { Facets } from "../../lib/segments/facets";
import { MatchCount } from "./MatchCount";
import { ScopeBuilder } from "./ScopeBuilder";

const FACETS: Facets = {
  collections: ["Outerwear"],
  tags: ["sale", "clearance"],
  vendors: ["Acme"],
  productTypes: ["Boots", "Gloves"],
  totals: { collections: 1, tags: 2, vendors: 1, productTypes: 2 },
};

const render = (initial: ScopeDraft, titles: Record<string, string> = {}) =>
  renderToStaticMarkup(<ScopeBuilder facets={FACETS} initial={initial} pickedTitles={titles} count={<MatchCount matched={42} pending={false} />} />);

/** The hidden field's value, as the form would post it. */
function posted(html: string): ScopeDraft | null {
  const value = /<input[^>]*name="scope"[^>]*value="([^"]*)"/.exec(html)?.[1] ?? "";
  return decodeScope(value.replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
}

describe("the filter builder", () => {
  it("posts one field, which reads back as what it was given", () => {
    const draft: ScopeDraft = {
      groups: [
        { conditions: [{ field: "productType", values: ["Boots", "Gloves"] }, { field: "inventoryMin", values: ["50"] }] },
        { conditions: [{ field: "hasCost", values: ["yes"] }] },
      ],
      include: ["gid://shopify/ProductVariant/1"],
      exclude: ["gid://shopify/ProductVariant/2"],
    };
    expect(posted(render(draft))).toEqual(draft);
  });

  it("starts empty, covering everything, with a way to add a condition", () => {
    const html = render(EMPTY_SCOPE);
    expect(posted(html)).toEqual(EMPTY_SCOPE);
    expect(html).toMatch(/With no\s+conditions, this covers every product/);
    expect(html).toContain("Add a condition");
    expect(html).not.toContain("Or another group");
  });

  it("says the groups are joined by or", () => {
    const html = render({ ...EMPTY_SCOPE, groups: [{ conditions: [{ field: "tag", values: ["sale"] }] }, { conditions: [{ field: "tag", values: ["clearance"] }] }] });
    expect(html).toContain(">or<");
    expect(html).toContain("Or another group");
  });

  it("shows a picked field's values as chips, and offers the rest", () => {
    const html = render({ ...EMPTY_SCOPE, groups: [{ conditions: [{ field: "productType", values: ["Boots"] }] }] });
    expect(html).toMatch(/<s-clickable-chip[^>]*>Boots<\/s-clickable-chip>/);
    expect(html).toMatch(/<s-option value="Gloves">Gloves<\/s-option>/);
    expect(html).not.toMatch(/<s-option value="Boots">/);
  });

  it("names picked products, and offers the picker for both lists", () => {
    const html = render({ ...EMPTY_SCOPE, include: ["gid://shopify/ProductVariant/1"] }, { "gid://shopify/ProductVariant/1": "Boot · Size 9" });
    expect(html).toContain("Boot · Size 9");
    expect(html).toContain("Add products");
    expect(html).toContain("Leave products out");
  });

  it("puts the count under it", () => {
    expect(render(EMPTY_SCOPE)).toContain("Matches 42 variants.");
  });

  it("renders a control for every kind of field", () => {
    const html = render({
      ...EMPTY_SCOPE,
      groups: [
        {
          conditions: [
            { field: "title", values: ["parka"] },
            { field: "inventoryMax", values: ["3"] },
            { field: "status", values: ["DRAFT"] },
            { field: "hasCost", values: ["no"] },
          ],
        },
      ],
    });
    expect(html).toMatch(/<s-text-field[^>]*label="Title contains"[^>]*value="parka"/);
    expect(html).toMatch(/<s-number-field[^>]*label="Stock at most"[^>]*value="3"/);
    expect(html).toMatch(/<s-option value="DRAFT" selected="">Draft<\/s-option>|<s-option value="DRAFT"[^>]*>Draft/);
    expect(html).toContain("is not recorded");
  });
});
