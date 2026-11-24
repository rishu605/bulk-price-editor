/**
 * The filter builder's one reading (#817, D32): what it offers, what it compiles to, and that a
 * scope built with the controls before it compiles to what it always did.
 */

import { describe, expect, it } from "vitest";

import { astFrom, readerFor } from "../campaigns/draft-form";
import { astToWhere } from "../../services/segments.server";
import {
  astOfDraft,
  BUILDER_FIELDS,
  builderNarrows,
  decodeScope,
  draftOfAst,
  EMPTY_SCOPE,
  encodeScope,
  MAX_PICKED,
  scopeFrom,
  type ScopeDraft,
} from "./scope-builder";

const read = (fields: Record<string, string>) => readerFor(new URLSearchParams(fields));
const posted = (draft: ScopeDraft) => read({ scope: encodeScope(draft) });
const gid = (n: number) => `gid://shopify/ProductVariant/${n}`;

describe("what the builder offers (D32)", () => {
  /**
   * Written down a second time on purpose, as `scope-fields.test.ts` does for the editor's old
   * fields: adding one here says a merchant is meant to set it, and removing one the opposite.
   */
  const SHIPPED = [
    "barcode",
    "collection",
    "excludeTag",
    "hasCost",
    "inventoryMax",
    "inventoryMin",
    "productType",
    "sku",
    "status",
    "tag",
    "title",
    "vendor",
  ];

  it("offers every condition that ships", () => {
    expect([...BUILDER_FIELDS].sort()).toEqual(SHIPPED);
  });

  it("does not offer the dormant ones, which read what a campaign writes", () => {
    // A price range and compare-at presence read the live price and compare-at, so a campaign
    // scoped by them moves its own variants out of its scope as it prices them (D32).
    for (const dormant of ["priceMin", "priceMax", "hasCompareAt"]) {
      expect(BUILDER_FIELDS as readonly string[]).not.toContain(dormant);
    }
  });

  it("drops a field it does not offer, rather than compiling it", () => {
    const raw = JSON.stringify({ groups: [{ conditions: [{ field: "priceMin", values: ["10"] }, { field: "tag", values: ["sale"] }] }] });
    expect(decodeScope(raw)?.groups[0].conditions).toEqual([{ field: "tag", values: ["sale"] }]);
  });
});

describe("what it compiles to", () => {
  it("is every variant when it holds nothing, as a blank form always was", () => {
    const reading = scopeFrom(posted(EMPTY_SCOPE));
    expect(reading).toMatchObject({ ok: true, ast: { groups: [] } });
  });

  it("keeps one value a string, so a one-value scope is the AST it always was", () => {
    const reading = scopeFrom(posted({ ...EMPTY_SCOPE, groups: [{ conditions: [{ field: "tag", values: ["sale"] }, { field: "vendor", values: ["Acme"] }] }] }));
    expect(reading.ok && reading.ast).toEqual(astFrom(read({ tag: "sale", vendor: "Acme" })));
  });

  it("makes several values a list, any of them", () => {
    const reading = scopeFrom(posted({ ...EMPTY_SCOPE, groups: [{ conditions: [{ field: "productType", values: ["Boots", "Gloves"] }] }] }));
    expect(reading.ok && reading.ast.groups).toEqual([{ conditions: [{ field: "productType", value: ["Boots", "Gloves"] }] }]);
  });

  it("makes several tags left out several excludeTag conditions, which every release reads", () => {
    const reading = scopeFrom(posted({ ...EMPTY_SCOPE, groups: [{ conditions: [{ field: "excludeTag", values: ["no-sale", "gift"] }] }] }));
    expect(reading.ok && reading.ast.groups[0].conditions).toEqual([
      { field: "excludeTag", value: "no-sale" },
      { field: "excludeTag", value: "gift" },
    ]);
  });

  it("joins groups with OR, and drops a group with nothing in it", () => {
    const reading = scopeFrom(
      posted({
        ...EMPTY_SCOPE,
        groups: [
          { conditions: [{ field: "tag", values: ["sale"] }, { field: "inventoryMin", values: ["50"] }] },
          { conditions: [{ field: "vendor", values: [] }] },
          { conditions: [{ field: "hasCost", values: ["no"] }, { field: "status", values: ["draft"] }] },
        ],
      }),
    );
    expect(reading.ok && reading.ast.groups).toEqual([
      { conditions: [{ field: "tag", value: "sale" }, { field: "inventoryMin", value: 50 }] },
      { conditions: [{ field: "hasCost", value: false }, { field: "status", value: "DRAFT" }] },
    ]);
  });

  it("adds picked variants as a group of their own, and leaves out the others over every group", () => {
    const reading = scopeFrom(
      posted({ groups: [{ conditions: [{ field: "tag", values: ["sale"] }] }], include: [gid(1), gid(2)], exclude: [gid(3)] }),
    );
    expect(reading.ok && reading.ast).toEqual({
      groups: [
        { conditions: [{ field: "tag", value: "sale" }] },
        { conditions: [{ field: "variantGid", value: [gid(1), gid(2)] }] },
      ],
      excludeVariantGids: [gid(3)],
    });
  });

  it("carries picked variants as their numbers, and reads them back as gids", () => {
    const encoded = encodeScope({ ...EMPTY_SCOPE, include: [gid(46172975726826)] });
    expect(encoded).toContain('"46172975726826"');
    expect(encoded).not.toContain("gid://");
    expect(decodeScope(encoded)?.include).toEqual([gid(46172975726826)]);
  });

  it("compiles the left-out variants beside the groups, so they hold over all of them", () => {
    const where = astToWhere("shop_1", { groups: [{ conditions: [{ field: "tag", value: "a" }] }, { conditions: [{ field: "tag", value: "b" }] }], excludeVariantGids: [gid(3)] });
    expect(where).toMatchObject({ variantGid: { notIn: [gid(3)] }, OR: [{ AND: [{ tags: { has: "a" } }] }, { AND: [{ tags: { has: "b" } }] }] });
  });

  it("compiles several values to any of them", () => {
    const where = astToWhere("shop_1", {
      groups: [{ conditions: [{ field: "tag", value: ["a", "b"] }, { field: "vendor", value: ["X", "Y"] }, { field: "excludeTag", value: ["c", "d"] }] }],
    });
    expect(where.OR).toEqual([
      {
        AND: [
          { tags: { hasSome: ["a", "b"] } },
          { OR: [{ vendor: { equals: "X", mode: "insensitive" } }, { vendor: { equals: "Y", mode: "insensitive" } }] },
          { NOT: { tags: { hasSome: ["c", "d"] } } },
        ],
      },
    ]);
  });
});

describe("what it refuses, by name", () => {
  it("refuses a stock that is not a whole number", () => {
    const reading = scopeFrom(posted({ ...EMPTY_SCOPE, groups: [{ conditions: [{ field: "inventoryMin", values: ["5.5"] }] }] }));
    expect(reading).toMatchObject({ ok: false, problem: 'Stock at least "5.5" is not a whole number. Enter one, such as 50.' });
  });

  it("refuses more picked variants than the link can carry, and says where a longer list goes", () => {
    const reading = astOfDraft({ ...EMPTY_SCOPE, include: Array.from({ length: MAX_PICKED + 1 }, (_, i) => gid(i)) });
    expect(reading.ok).toBe(false);
    expect(!reading.ok && reading.problem).toMatch(/list segment under Settings → Segments/);
  });

  it("refuses a field it cannot read at all, rather than pricing everything", () => {
    expect(scopeFrom(read({ scope: "{not json" }))).toMatchObject({ ok: false });
  });
});

describe("the fields before it", () => {
  it("reads a form without the builder's field the old way", () => {
    const reading = scopeFrom(read({ collection: "Outerwear", excludeTag: "no-sale" }));
    expect(reading.ok && reading.ast).toEqual(astFrom(read({ collection: "Outerwear", excludeTag: "no-sale" })));
    expect(reading.draft.groups[0].conditions).toEqual([
      { field: "collection", values: ["Outerwear"] },
      { field: "excludeTag", values: ["no-sale"] },
    ]);
  });
});

describe("a stored AST, back in the builder", () => {
  it("reads back what it wrote", () => {
    const draft: ScopeDraft = {
      groups: [
        { conditions: [{ field: "tag", values: ["a", "b"] }, { field: "excludeTag", values: ["c", "d"] }, { field: "inventoryMax", values: ["3"] }] },
        { conditions: [{ field: "hasCost", values: ["yes"] }] },
      ],
      include: [gid(1)],
      exclude: [gid(2)],
    };
    const reading = astOfDraft(draft);
    expect(reading.ok && draftOfAst(reading.ast)).toEqual(draft);
  });

  it("shows a segment saved by the old form", () => {
    expect(draftOfAst({ groups: [{ conditions: [{ field: "collection", value: "Summer" }, { field: "vendor", value: "Acme" }] }] })).toEqual({
      ...EMPTY_SCOPE,
      groups: [{ conditions: [{ field: "collection", values: ["Summer"] }, { field: "vendor", values: ["Acme"] }] }],
    });
  });
});

describe("the guided first campaign (#624)", () => {
  it("counts a condition or a picked product as narrowing, and a tag left out as not", () => {
    expect(builderNarrows(posted({ ...EMPTY_SCOPE, groups: [{ conditions: [{ field: "sku", values: ["SNOW"] }] }] }))).toBe(true);
    expect(builderNarrows(posted({ ...EMPTY_SCOPE, include: [gid(1)] }))).toBe(true);
    expect(builderNarrows(posted({ ...EMPTY_SCOPE, groups: [{ conditions: [{ field: "excludeTag", values: ["x"] }] }] }))).toBe(false);
    expect(builderNarrows(posted({ ...EMPTY_SCOPE, exclude: [gid(1)] }))).toBe(false);
    expect(builderNarrows(read({}))).toBe(false);
  });
});
