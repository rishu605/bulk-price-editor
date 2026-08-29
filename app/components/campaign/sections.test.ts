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

import { readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { rawSource, sourceOf } from "../../lib/testing/source";

const DIR = join(process.cwd(), "app", "components", "campaign");
const ROUTE = join(process.cwd(), "app", "routes", "app.campaigns.$id.tsx");

const everything = [
  ...readdirSync(DIR)
    .filter((f) => f.endsWith(".tsx") && !f.endsWith(".test.tsx"))
    .map((f) => sourceOf(DIR, f)),
  sourceOf(ROUTE),
].join("\n");

/**
 * The sections the page carried before the split.
 *
 * "Actions" is not among them any more, and the way it left is the reason this file now
 * reads source with its comments stripped. The section was dissolved in #395's successor:
 * a card titled after a *category of thing*, holding a row of buttons, became the header
 * row itself. The check went on passing for months afterwards — because `CampaignHeader`'s
 * docstring quotes the `heading="Actions"` it replaced, and a census that reads its own
 * commentary finds whatever the commentary mentions.
 *
 * A guard that a deletion cannot fail is not guarding anything.
 */
const SECTIONS = [
  "Preview",
  "Approval",
  "What this does to your margins",
  "Markets",
  "Run history",
  "If you revert this campaign",
  "Ledger",
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
      expect(sourceOf(DIR, file), `${file} still marks content as aside`)
        .not.toContain('slot="aside"');
    }
  });

  it("keeps the route small enough to read", () => {
    // `rawSource`, not `sourceOf`. This one is about the file as a person opens it, and
    // comments are most of what makes a long file long — measuring the stripped source
    // would let the route grow past any limit as long as the growth was documented.
    const lines = rawSource(ROUTE).split("\n").length;
    expect(lines, "the page was 690 lines with everything in one component").toBeLessThan(400);
  });
});
