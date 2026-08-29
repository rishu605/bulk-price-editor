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

describe("the rule, as a merchant would say it", () => {
  it("says off for a discount, not a minus sign", () => {
    // "-20%" is a worse way to say it: a minus is one character wide in a scanned column.
    expect(describeRule({ kind: "percent-change", percent: -20 })).toBe("20% off");
  });

  it("says increase for a rise, so the two cannot be confused", () => {
    expect(describeRule({ kind: "percent-change", percent: 15 })).toBe("15% increase");
  });

  it("keeps a fractional percentage without inventing precision", () => {
    expect(describeRule({ kind: "percent-change", percent: -12.5 })).toBe("12.5% off");
    expect(describeRule({ kind: "percent-change", percent: -20.0 })).toBe("20% off");
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
