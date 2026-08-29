/**
 * What a campaign does, in one sentence, in one place.
 *
 * The index listed a name, a status, a priority and a last run — everything *about* a
 * campaign and nothing about what it is. Sami renders "Price decrease by 10%" beside "All
 * products"; NA writes the row as "20% off sale on 1 product variant". Either answers
 * "what is this" without opening anything.
 *
 * The sign is the part with a wrong answer available. A rule stored as `-20` is 20% off,
 * and a formatter that lost the minus would label a discount as a price rise in a column
 * merchants scan rather than read.
 */

import { describe, expect, it } from "vitest";

import { describeRule, describeScope } from "./describe";
import { money } from "../money/money";

/**
 * The space between an amount and its word is non-breaking — "20%\u00a0off", not
 * "20% off". `describeRule` carries the reason: a two-word value under a four-letter
 * header is the column an auto-layout table always chooses to wrap, and the campaigns
 * index was rendering "25%" over "off". Spelled as an escape in these assertions rather
 * than pasted in as an invisible character, so a reader can see which space is meant.
 */
describe("the rule, as a merchant would say it", () => {
  it("says off for a discount, not a minus sign", () => {
    // "-20%" is a worse way to say it: a minus is one character wide in a scanned column.
    expect(describeRule({ kind: "percent-change", percent: -20 })).toBe("20%\u00a0off");
  });

  it("says increase for a rise, so the two cannot be confused", () => {
    expect(describeRule({ kind: "percent-change", percent: 15 })).toBe("15%\u00a0increase");
  });

  it("keeps a fractional percentage without inventing precision", () => {
    expect(describeRule({ kind: "percent-change", percent: -12.5 })).toBe("12.5%\u00a0off");
    expect(describeRule({ kind: "percent-change", percent: -20.0 })).toBe("20%\u00a0off");
  });

  it("formats an amount in its own currency", () => {
    expect(describeRule({ kind: "fixed-change", amount: money(-1000, "USD") })).toContain("off");
    expect(describeRule({ kind: "fixed-change", amount: money(1000, "USD") })).toContain("more");
  });

  it("names an exact price as a price, not as a change", () => {
    expect(describeRule({ kind: "set-exact", amount: money(2999, "USD") })).toContain("Set to");
  });

  it("says where the prices came from for a file, rather than inventing one rule", () => {
    // A campaign priced from a spreadsheet has one rule per variant; there is no single
    // sentence for it, and pretending otherwise would be a lie in a scannable column.
    expect(describeRule({ kind: "from-import", importId: "imp_1" })).toBe("Prices from a file");
  });

  it("does not describe a zero as a discount", () => {
    expect(describeRule({ kind: "percent-change", percent: 0 })).toBe("No change");
    expect(describeRule({ kind: "fixed-change", amount: money(0, "USD") })).toBe("No change");
  });

  it("says something for a campaign with no rule at all", () => {
    expect(describeRule(null)).toBe("No rule");
    expect(describeRule(undefined)).toBe("No rule");
  });
});

describe("what it applies to", () => {
  it("says the whole catalogue in as many words", () => {
    // The scope with the largest consequence and the least visible cause. An empty cell
    // here reads as missing data rather than as "everything".
    expect(describeScope({ groups: [] })).toBe("All variants");
    expect(describeScope(null)).toBe("All variants");
  });

  it("reads a filter as a phrase", () => {
    expect(
      describeScope({ groups: [{ conditions: [{ field: "collection", value: "Outerwear" }] }] }),
    ).toBe("In Outerwear");
  });

  it("joins several conditions, which combine with AND", () => {
    expect(
      describeScope({
        groups: [
          {
            conditions: [
              { field: "collection", value: "Outerwear" },
              { field: "tag", value: "sale" },
            ],
          },
        ],
      }),
    ).toBe("In Outerwear · Tagged sale");
  });

  it("reads separate groups as OR, because that is what they are", () => {
    // `astToWhere` ANDs the conditions inside a group and ORs the groups. `describeScope`
    // used to flatten both into one `·` run, so the two structures the merchant can build
    // came out as the same sentence — and `·` reads as AND.
    expect(
      describeScope({
        groups: [
          { conditions: [{ field: "collection", value: "Outerwear" }] },
          { conditions: [{ field: "tag", value: "clearance" }] },
        ],
      }),
    ).toBe("In Outerwear or Tagged clearance");
  });

  it("keeps AND inside a group and OR between groups", () => {
    expect(
      describeScope({
        groups: [
          {
            conditions: [
              { field: "collection", value: "Outerwear" },
              { field: "tag", value: "sale" },
            ],
          },
          { conditions: [{ field: "vendor", value: "Nike" }] },
        ],
      }),
    ).toBe("In Outerwear · Tagged sale or By Nike");
  });

  it("lists values once when every group is the same field", () => {
    // The commonest scope anyone builds, and the one that was worst. Five product types
    // came out as "productType: Backpack · productType: Boots · ..." — a hundred-odd
    // characters describing, in this function's own spelling of AND, a scope that would
    // match nothing. It was also the widest cell in the campaigns table, which on
    // `s-table`'s auto layout wrapped "25% off" onto two lines to make room for it.
    expect(
      describeScope({
        groups: [
          { conditions: [{ field: "productType", value: "Backpack" }] },
          { conditions: [{ field: "productType", value: "Boots" }] },
          { conditions: [{ field: "productType", value: "Gloves" }] },
        ],
      }),
    ).toBe("Type Backpack, Boots or Gloves");
  });

  it("does not list values for a field whose phrase quotes them", () => {
    // "Title contains “parka”, boots" would read as though only the first is quoted.
    expect(
      describeScope({
        groups: [
          { conditions: [{ field: "title", value: "parka" }] },
          { conditions: [{ field: "title", value: "boots" }] },
        ],
      }),
    ).toBe("Title contains “parka” or Title contains “boots”");
  });

  it("names the fields the filter builder actually offers", () => {
    // These fell through to `field: value` — the branch meant for a field nobody
    // anticipated — while being four of the nine `conditionToWhere` handles.
    expect(
      describeScope({ groups: [{ conditions: [{ field: "productType", value: "Boots" }] }] }),
    ).toBe("Type Boots");
    expect(
      describeScope({ groups: [{ conditions: [{ field: "status", value: "active" }] }] }),
    ).toBe("Status active");
    expect(
      describeScope({ groups: [{ conditions: [{ field: "sku", value: "ANC-1" }] }] }),
    ).toBe("SKU contains “ANC-1”");
    expect(
      describeScope({ groups: [{ conditions: [{ field: "barcode", value: "5012" }] }] }),
    ).toBe("Barcode contains “5012”");
  });

  it("counts a pinned variant list rather than listing gids", () => {
    expect(
      describeScope({
        groups: [{ conditions: [{ field: "variantGid", value: ["gid://1", "gid://2"] }] }],
      }),
    ).toBe("2 chosen variants");
  });

  it("prefers the segment, because a segment replaces the filter rather than narrowing it", () => {
    // Showing the inline filter for a segment-scoped campaign describes a filter the
    // campaign is ignoring.
    expect(
      describeScope({ groups: [{ conditions: [{ field: "tag", value: "sale" }] }] }, "Winter lines"),
    ).toBe("Winter lines");
  });

  it("still says something for a field nobody anticipated", () => {
    // The same argument `describeAction` makes about not being a lookup table: a
    // plausible phrase for a condition nobody planned beats an empty cell. Cast because
    // `ConditionField` is a closed union today and the point is what happens when it is
    // not.
    expect(
      describeScope({
        groups: [{ conditions: [{ field: "colour" as never, value: "red" }] }],
      }),
    ).toBe("colour: red");
  });
});
