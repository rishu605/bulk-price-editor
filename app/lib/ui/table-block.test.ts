/**
 * A table, its caption and its pagination are one object.
 *
 * They were three separate children of the card, spaced by the card's own rhythm — the gap
 * meant for the distance between a paragraph and the fields under it. So on Variants the
 * rows, "Amounts are your store's base price, in USD." and "51–100 of 3,412" sat as far
 * apart as two unrelated blocks, and none of them read as belonging to the rows above.
 *
 * The parts already existed and were shared: `Pagination`, `ShowingSome`, and a caption
 * written out per route. What did not exist was anything binding them to the table they
 * describe, which is why the order differed between routes too.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { sourceOf } from "../testing/source";

const APP = join(process.cwd(), "app");

function sources(dir: string): Array<{ path: string; source: string }> {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    if (!entry.name.endsWith(".tsx") || entry.name.includes(".test.")) return [];
    return [{ path: path.replace(`${APP}/`, ""), source: sourceOf(path) }];
  });
}

const files = sources(APP);

describe("every pager belongs to a table", () => {
  it("finds the files, so this cannot pass by checking nothing", () => {
    const paged = files.filter(
      ({ source }) => source.includes("<Pagination") || source.includes("<ShowingSome"),
    );

    expect(paged.length).toBeGreaterThanOrEqual(8);
  });

  it("nobody renders a pager outside a TableBlock", () => {
    // Loose, it is a control floating a card's-width away from the rows it pages.
    const offenders = files
      .filter(({ path }) => path !== "components/TableBlock.tsx" && path !== "components/Pagination.tsx")
      .filter(({ source }) => source.includes("<Pagination") || source.includes("<ShowingSome"))
      .filter(({ source }) => !source.includes("<TableBlock"))
      .map(({ path }) => path);

    expect(offenders, "a pager with no table is a control with nothing to control").toEqual([]);
  });
});

describe("the block itself", () => {
  const block = sourceOf(join(APP, "components", "TableBlock.tsx"));

  it("holds the three together at a tighter gap than the card's", () => {
    // Three things at the card's rhythm are three things. At item rhythm they are one
    // thing with two footnotes, which is what they are.
    expect(block).toContain("gap={SPACE.item}");
  });

  it("puts the caption with the rows and the pager after both", () => {
    // A caption qualifies the rows, so it is read with them. Pagination is a control that
    // moves you off the rows, so it comes after everything describing them. Routes had it
    // both ways round before this settled it.
    const body = block.slice(block.indexOf("<s-stack"));

    expect(body.indexOf("{children}")).toBeLessThan(body.indexOf("{caption}"));
    expect(body.indexOf("{caption}")).toBeLessThan(body.indexOf("{pagination}"));
  });
});
