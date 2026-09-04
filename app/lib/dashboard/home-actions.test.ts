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

/**
 * Each entry in the page's attention list, from its heading to the end of its body.
 *
 * They were four separate banners once. A shop with all four open met a wall of yellow
 * with the most consequential item indistinguishable from the least, so they are one
 * block with a list inside it — which means this can no longer count banners, and counts
 * what the merchant is actually being asked to deal with.
 */
function attentionItems(source: string): string[] {
  const list = source.slice(
    source.indexOf("const attention: Array<{"),
    source.indexOf("return (\n    <PageShell"),
  );

  return list
    .split("attention.push({")
    .slice(1)
    .map((item) => item.slice(0, item.indexOf("\n    });")));
}

describe("a warning on Home offers its own remedy", () => {
  const items = attentionItems(home);

  it("finds the items, so this cannot pass by checking nothing", () => {
    expect(items.length).toBeGreaterThanOrEqual(4);
  });

  it("every one of them has a button", () => {
    const silent = items
      .filter((item) => !item.includes("<s-button"))
      .map((item) => /heading: "([^"]*)"/.exec(item)?.[1] ?? item.slice(0, 60));

    expect(
      silent,
      "a warning with no action makes the merchant go looking, and looking is where they find the wrong thing",
    ).toEqual([]);
  });

  it("the baseline warning re-syncs rather than describing a re-sync", () => {
    const item = items.find((each) => each.includes("no baseline"));

    expect(item).toBeDefined();
    expect(item).toContain('value="sync"');
  });

  it("leads with the run that stopped, not with the tidiest item", () => {
    // The order is the argument: prices are live that nobody chose. A variant with no
    // baseline cannot be put in a campaign at all, which matters, but not today.
    const headings = items.map((item) => /heading: "([^"]*)"/.exec(item)?.[1] ?? "");

    expect(headings[0]).toContain("did not finish cleanly");
    expect(headings[headings.length - 1]).toContain("no baseline");
  });

  it("renders one block rather than a stack of banners", () => {
    const banners = [...home.matchAll(/<s-banner/g)].length;

    // Two: the attention block, and the one that reports the result of an action the
    // merchant has just taken.
    expect(banners, "the wall of yellow is back").toBeLessThanOrEqual(2);
  });
});

describe("one thing to do at a time", () => {
  /**
   * At most one primary button on the page, in every state a shop can be in.
   *
   * A first run rendered two: the checklist's "Sync catalogue" and, directly below it,
   * "Sync catalogue and capture baselines". The same operation under two names, in two
   * black buttons — and the louder-looking half of the pair was an anchor to `/app`, so
   * it reloaded the page the merchant was already on and did nothing.
   *
   * `action-row.test.tsx` already refuses two primaries inside one `s-section`. This is
   * the same rule read at the level a merchant reads it: two black buttons in two cards
   * are still two things being demanded at once.
   */
  const primaries = [...home.matchAll(/variant="primary"/g)].length;

  it("renders at most one unconditional primary button", () => {
    expect(
      primaries,
      "two black buttons is the page failing to say which one thing to do",
    ).toBeLessThanOrEqual(1);
  });

  it("does not offer the same operation under two names", () => {
    // "Sync catalogue" and "Sync catalogue and capture baselines" were one POST.
    const labels = [...home.matchAll(/busy \? "Syncing…" : "([^"]+)"/g)].map((match) => match[1]);

    // Two are allowed and two is the ceiling: a first sync and a re-sync are different
    // requests to make of a merchant even though they post the same intent. What is not
    // allowed is a third name, or the pair that started this — "Sync catalogue" and
    // "Sync catalogue and capture baselines" side by side on a first run.
    expect(labels.length).toBeGreaterThanOrEqual(1);
    expect(
      new Set(labels).size,
      `${[...new Set(labels)].join(" / ")} name one operation`,
    ).toBeLessThanOrEqual(2);
  });
});
