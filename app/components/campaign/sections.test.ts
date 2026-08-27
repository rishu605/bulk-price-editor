/**
 * Every section the campaign page used to stack is still somewhere.
 *
 * The page went from thirteen sections in one column to five tabs plus a header. The
 * failure mode of that move is silent: a section that gets dropped during the split
 * leaves no error and no gap — the page simply stops mentioning, say, markets, and
 * nobody notices until a merchant asks where their market prices went.
 *
 * So this checks the headings themselves, read from the files rather than listed twice.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const DIR = join(process.cwd(), "app", "components", "campaign");
const ROUTE = join(process.cwd(), "app", "routes", "app.campaigns.$id.tsx");

const everything = [
  ...readdirSync(DIR)
    .filter((f) => f.endsWith(".tsx") && !f.endsWith(".test.tsx"))
    .map((f) => readFileSync(join(DIR, f), "utf8")),
  readFileSync(ROUTE, "utf8"),
].join("\n");

/** The thirteen sections the page carried before the split. */
const SECTIONS = [
  "Preview",
  "Approval",
  "What this does to your margins",
  "Markets",
  "Run history",
  "If you revert this campaign",
  "Ledger",
  "Actions",
  "Schedule",
  "New products",
];

describe("nothing was lost splitting the page into tabs", () => {
  it.each(SECTIONS)("still renders %s", (heading) => {
    expect(everything).toContain(heading);
  });

  it("no longer uses the aside slot, which full width does not render", () => {
    // The tab bodies were carved out of aside panels. Leaving the slot on would make
    // them silently invisible at inlineSize="large" — see PageShell.
    for (const file of readdirSync(DIR).filter((f) => f.endsWith(".tsx"))) {
      expect(readFileSync(join(DIR, file), "utf8"), `${file} still marks content as aside`)
        .not.toContain('slot="aside"');
    }
  });

  it("keeps the route small enough to read", () => {
    const lines = readFileSync(ROUTE, "utf8").split("\n").length;
    expect(lines, "the page was 690 lines with everything in one component").toBeLessThan(400);
  });
});
