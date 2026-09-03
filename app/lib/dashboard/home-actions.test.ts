/**
 * Every warning on Home carries the action it asks for.
 *
 * "Some variants have no baseline" told the merchant that re-syncing would capture them
 * and offered no button; the re-sync it meant was in the Store card two columns away,
 * below the plan.
 *
 * That is the shape of the worst bug this product has had. #252: the bulk catalogue
 * import wrote `variant_index` and not `price_surface_entries`, so every bulk-imported
 * variant was mirrored, counted and listed and could never be priced — and the dashboard
 * said "N variants have no baseline yet — re-sync to capture them", where re-syncing ran
 * the bulk path again. The warning could not be cleared by the only action offered for
 * clearing it.
 *
 * The lesson generalises past that one bug: a warning whose remedy is not on the warning
 * is a warning the merchant has to go looking to satisfy, and looking is where they find
 * the wrong thing. So this is a rule about the page, checked, rather than a note.
 */

import { describe, expect, it } from "vitest";

import { sourceOf } from "../testing/source";

const home = sourceOf(process.cwd(), "app", "routes", "app._index.tsx");

/** Each `<s-banner …>` on the page, from its tag to its close. */
function banners(source: string): string[] {
  const found: string[] = [];
  let from = source.indexOf("<s-banner");

  while (from !== -1) {
    const end = source.indexOf("</s-banner>", from);
    found.push(source.slice(from, end));
    from = source.indexOf("<s-banner", end);
  }

  return found;
}

describe("a warning on Home offers its own remedy", () => {
  const warnings = banners(home).filter(
    (banner) => banner.includes('tone="warning"') || banner.includes('tone="info"'),
  );

  it("finds the warnings, so this cannot pass by checking nothing", () => {
    expect(warnings.length).toBeGreaterThanOrEqual(4);
  });

  it("every one of them has a button or a link", () => {
    const silent = warnings
      .filter((banner) => !banner.includes("<s-button"))
      .map((banner) => /heading="([^"]*)"/.exec(banner)?.[1] ?? banner.slice(0, 60));

    expect(
      silent,
      "a warning with no action makes the merchant go looking, and looking is where they find the wrong thing",
    ).toEqual([]);
  });

  it("the baseline warning re-syncs rather than describing a re-sync", () => {
    const banner = warnings.find((each) => each.includes("no baseline"));

    expect(banner).toBeDefined();
    expect(banner).toContain('value="sync"');
  });
});

describe("one sync, however many places offer it", () => {
  it("every sync on the page posts the same intent", () => {
    // The Store card's button and the banner's are two forms. What must not drift is
    // what they post: a second intent would be a second code path for the operation
    // this page exists to get right.
    const intents = [...home.matchAll(/name="intent" value="([^"]+)"/g)].map((match) => match[1]);
    const syncs = intents.filter((intent) => intent.includes("sync"));

    expect(syncs.length).toBeGreaterThanOrEqual(2);
    expect(new Set(syncs).size, `two spellings of one operation: ${[...new Set(syncs)]}`).toBe(1);
  });
});
