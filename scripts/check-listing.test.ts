/**
 * What the listing guard concludes from the copy.
 *
 * The guard's whole value is refusing things, so each check is tested by mutating the
 * real document until it should fail. A guard nobody has watched fail is a guard that
 * passes for the wrong reason, and this one has three separate ways to pass vacuously:
 * a heading it cannot find, a fenced block it cannot parse, and a pricing table whose
 * rows it silently skips.
 *
 * The baseline case reads the committed copy, so this also fails when someone edits the
 * listing past a limit without running the script.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { checkAll, checkCopy, checkDashes, checkPricing, fencedBlock, sectionOf } from "./check-listing";

const doc = readFileSync("docs/listing/copy.md", "utf8");

/** Mutating the committed copy, so a mutation cannot drift from the document it edits. */
const mutate = (find: string, replace: string): string => {
  expect(doc, `the copy no longer contains ${JSON.stringify(find)}`).toContain(find);
  return doc.replace(find, replace);
};

describe("the committed copy", () => {
  it("has no problems", () => {
    expect(checkAll(doc)).toEqual([]);
  });
});

describe("field limits", () => {
  it("refuses a field over its limit", () => {
    const over = mutate("Anchor: Bulk Price Editor", "Anchor: Bulk Price Editor for Every Shopify Store");

    expect(checkCopy(over)).toContainEqual(
      expect.objectContaining({ field: "App name" }),
    );
  });

  it("refuses more entries than Shopify accepts", () => {
    const sixth = mutate(
      "Preview, full history and one-click rollback on every plan, including free",
      "Preview, full history and one-click rollback on every plan, including free\nA sixth bullet",
    );

    expect(checkCopy(sixth)).toContainEqual(
      expect.objectContaining({ field: "Feature list", message: expect.stringContaining("at most 5") }),
    );
  });

  it("refuses a stated limit that disagrees with the real one", () => {
    const wrong = mutate("Limit 62.", "Limit 70.");

    expect(checkCopy(wrong)).toContainEqual(
      expect.objectContaining({ field: "App card subtitle", message: expect.stringContaining("Shopify's limit is 62") }),
    );
  });

  it("refuses a section whose value it cannot find, rather than passing it", () => {
    const blockless = mutate("```\nAnchor: Bulk Price Editor\n```", "Anchor: Bulk Price Editor");

    expect(checkCopy(blockless)).toContainEqual(
      expect.objectContaining({ field: "App name", message: expect.stringContaining("no fenced block") }),
    );
  });

  it("refuses a heading it cannot find, rather than skipping it", () => {
    const renamed = mutate("## App introduction", "## Intro");

    expect(checkCopy(renamed)).toContainEqual(
      expect.objectContaining({ field: "App introduction", message: expect.stringContaining("no section") }),
    );
  });
});

describe("house style", () => {
  it("refuses an em dash", () => {
    expect(checkDashes(mutate("as a campaign.", "as a campaign — always."))).toHaveLength(1);
  });

  it("refuses an en dash", () => {
    expect(checkDashes(mutate("as a campaign.", "as a campaign – always."))).toHaveLength(1);
  });

  it("passes the committed copy", () => {
    expect(checkDashes(doc)).toEqual([]);
  });
});

describe("pricing against plans.ts", () => {
  it("refuses a price the code does not charge", () => {
    expect(checkPricing(mutate("$14.90 / month", "$19.90 / month"))).toContainEqual(
      expect.objectContaining({ field: "Pricing", message: expect.stringContaining("Growth price") }),
    );
  });

  it("refuses a variant limit the code does not enforce", () => {
    expect(checkPricing(mutate("| 10,000 |", "| 25,000 |"))).toContainEqual(
      expect.objectContaining({ field: "Pricing", message: expect.stringContaining("Growth variants") }),
    );
  });

  it("refuses a surface the plan does not actually unlock", () => {
    const table = mutate("| Growth | $14.90 / month | 10,000 | No | No |", "| Growth | $14.90 / month | 10,000 | Yes | No |");

    expect(checkPricing(table)).toContainEqual(
      expect.objectContaining({ field: "Pricing", message: expect.stringContaining("Growth markets") }),
    );
  });

  it("refuses a missing plan rather than checking only the rows present", () => {
    const dropped = mutate("| Wholesale | $69.90 / month | Unlimited | Yes | Yes |\n", "");

    expect(checkPricing(dropped)).toContainEqual(
      expect.objectContaining({ field: "Pricing", message: expect.stringContaining("no row for the Wholesale plan") }),
    );
  });
});

describe("parsing", () => {
  it("stops a section at the next heading", () => {
    expect(sectionOf(doc, "App name")).not.toContain("## App card subtitle");
  });

  it("returns null for a heading that is not there", () => {
    expect(sectionOf(doc, "Nonexistent")).toBeNull();
  });

  it("reads a fenced block verbatim, newlines included", () => {
    const section = sectionOf(doc, "Search terms");

    expect(fencedBlock(section!)?.split("\n")).toHaveLength(5);
  });
});
