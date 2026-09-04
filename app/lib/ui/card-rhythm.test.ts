/**
 * The distances inside a card are decided once, the way the distances between them are.
 *
 * `PageShell` owns the rhythm *between* cards and states the argument: "page rhythm has to
 * be the largest gap on the screen to do its job. If a route can set it, some route
 * eventually sets it smaller than the gaps inside its own sections, and the page stops
 * having visible structure at all."
 *
 * One level down, nothing implemented it. On the deployed build at 4× zoom the guardrails
 * card ran heading → lede → secondary → checkbox → fields at four different distances, the
 * diagnostics card ran heading → sentence → label → field at a fifth, and Home's checklist
 * had a smaller gap above its first row than between its rows.
 *
 * Two things this holds, and the second is the one that will drift:
 *
 * - `Card` is where a card's gaps live, and they are smaller than the page's.
 * - A card's heading is separated from its content by the largest of them. That gap is the
 *   **only** lever this app has for making a heading read as a title: Polaris gives a card
 *   heading one weight and one size, and `type="small"` is not implemented by the runtime
 *   either (`Type.tsx` records the check). Air is what is left, so removing it is removing
 *   the distinction — which is #589, and why that ticket is answered from here.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { sourceOf } from "../testing/source";

const APP = join(process.cwd(), "app");
const CARD = join(APP, "components", "Card.tsx");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    if (!entry.name.endsWith(".tsx") || entry.name.includes(".test.")) return [];
    return [path];
  });
}

describe("the card rhythm", () => {
  const card = sourceOf(CARD);

  it("separates a heading from its content, which is the only lever there is", () => {
    // Without this a card is a paragraph with a bold first line.
    expect(card).toContain("paddingBlockStart");
    expect(card).toContain("HEADING_GAP");
  });

  it("keeps a lede and the line qualifying it tighter than everything else", () => {
    // They are one thought. Spacing them like separate blocks is what made a card read as
    // four unrelated paragraphs.
    const intro = card.slice(card.indexOf("const intro"), card.indexOf("return ("));

    expect(intro).toContain(`gap={SPACE.tight}`);
  });

  it("stays inside the page's own rhythm", () => {
    // Every gap a card uses is smaller than the gap between cards, or the page stops
    // having structure. `spacing.test.ts` refuses `SPACE.page` outside `PageShell`; this
    // is the other half — the tokens a card is allowed to reach for.
    const used = [...card.matchAll(/SPACE\.(\w+)/g)].map((match) => match[1]);

    expect(used.length).toBeGreaterThan(0);
    for (const token of used) {
      expect(
        ["section", "item", "tight"],
        `a card may not use SPACE.${token} — it is the page's, or larger than the page's`,
      ).toContain(token);
    }
  });
});

describe("cards use it", () => {
  /**
   * Read from the components directory rather than a list, so a card added next week is
   * covered without anybody remembering this file exists.
   *
   * Not every `s-section` is a `Card`: the aside column takes sections directly, because
   * `PageShell` partitions on the `slot` attribute and wrapping that would put page layout
   * inside a card. Those are exempt and say so with the slot.
   */
  const withSections = sources(APP)
    .map((path) => ({ path: path.replace(`${APP}/`, ""), source: sourceOf(path) }))
    .filter(({ source }) => source.includes("<s-section"));

  it("finds the files, so this cannot pass by checking nothing", () => {
    expect(withSections.length).toBeGreaterThanOrEqual(10);
  });

  it("a titled card in the main column is a Card", () => {
    const offenders = withSections
      .filter(({ path }) => path !== "components/Card.tsx")
      .flatMap(({ path, source }) =>
        [...source.matchAll(/<s-section[^>]*>/gs)]
          .filter((match) => match[0].includes("heading=") && !match[0].includes('slot="aside"'))
          .map(() => path),
      );

    // A set rather than a count, so a failure names the files.
    expect([...new Set(offenders)]).toEqual([]);
  });
});

