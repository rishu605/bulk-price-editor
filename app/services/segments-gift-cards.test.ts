/**
 * No campaign scope can ever contain a gift card.
 *
 * A gift card's price is its face value, so a percentage campaign does not discount a
 * product — it sells store credit for less than it is worth. Under Home's one-click
 * "put everything on sale" at 20%, a $100 gift card becomes $64, and nothing stops a
 * shopper buying it repeatedly. The catalogue mirror could not distinguish one from an
 * ordinary product at all: `CATALOG_BULK_QUERY` never asked for `isGiftCard`, so there
 * was no column for a rule to filter on even if a merchant had thought to write one.
 *
 * The exclusion lives in `astToWhere` rather than in its callers because that is the one
 * place a campaign's scope becomes a query — `loadCandidates`, `previewMatches`,
 * `draft-preview`, the plan meter in `run.server`, and the approvals and calendar counts
 * all compile through it. Every one of those was an opportunity to filter and miss.
 *
 * What these tests protect is the *placement*, not just the presence. A filter that ends
 * up inside the OR that the AST's groups compile to is worse than no filter: it reads
 * correctly in a diff, and it excludes gift cards only from scopes that match nothing
 * else.
 */

import { describe, expect, it } from "vitest";

import { astToWhere, type FilterAst } from "./segments.server";

const SHOP = "shop_1";

const everything: FilterAst = { groups: [] };

/** What "title contains Alpine, or vendor is Acme" compiles from. */
const twoGroups: FilterAst = {
  groups: [
    { conditions: [{ field: "title", value: "Alpine" }] },
    { conditions: [{ field: "vendor", value: "Acme" }] },
  ],
};

describe("astToWhere excludes gift cards", () => {
  it("excludes them from a scope that names no conditions at all", () => {
    // "All variants" — the scope Home's quick-create writes, and the one that turned
    // $100 of store credit into $64.
    expect(astToWhere(SHOP, everything)).toMatchObject({ isGiftCard: false });
  });

  it("excludes them from a scope built out of condition groups", () => {
    expect(astToWhere(SHOP, twoGroups)).toMatchObject({ isGiftCard: false });
  });

  it("puts the exclusion beside shopId, not inside the OR the groups compile to", () => {
    // This is the whole point. Prisma ANDs top-level keys with `OR`, so an exclusion at
    // the top level survives every group. The same key written into a group would be
    // satisfied by any *other* group matching, and a gift card would come straight back.
    const where = astToWhere(SHOP, twoGroups) as Record<string, unknown>;

    expect(Object.hasOwn(where, "isGiftCard")).toBe(true);

    const groups = (where.OR ?? []) as Array<Record<string, unknown>>;
    expect(groups.length).toBe(2);
    expect(
      JSON.stringify(groups).includes("isGiftCard"),
      "the exclusion is inside a group, where another group matching would defeat it",
    ).toBe(false);
  });

  it("is not something a merchant's own rule can widen back open", () => {
    // A condition naming gift cards cannot re-admit them: it lands in a group, and the
    // top-level `isGiftCard: false` is ANDed with whatever the groups produce. There is
    // no rule a merchant could write that makes discounting face value the intent, so
    // this is a floor rather than a default.
    const pinned: FilterAst = {
      groups: [
        { conditions: [{ field: "variantGid", value: ["gid://shopify/ProductVariant/9"] }] },
      ],
    };

    expect(astToWhere(SHOP, pinned)).toMatchObject({ isGiftCard: false });
  });

  it("keeps the tombstone exclusion it shares the base with", () => {
    // Both are floors on the same query. A change that introduced one by replacing the
    // other would pass every test above.
    expect(astToWhere(SHOP, everything)).toMatchObject({
      shopId: SHOP,
      deletedAt: null,
      isGiftCard: false,
    });
  });
});
