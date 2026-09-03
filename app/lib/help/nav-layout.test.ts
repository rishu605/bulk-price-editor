/**
 * The help index reads as a list.
 *
 * Each article was a title button followed by its blurb on the same line, and a button is
 * as wide as its label — so every blurb started at a different x. "and why every campaign
 * computes from it" began about a hundred and thirty pixels right of "one winner per
 * product, never stacked", and a reader scanning for the article they want had no column
 * to scan down.
 *
 * Two things this pins, because both are the kind that revert quietly:
 *
 * - The rows are grid cells, not inline stacks. An inline stack is exactly what was there
 *   and it looks reasonable in the source.
 * - Every article contributes both cells even when it has no blurb. A grid places its
 *   children in order, so one skipped cell pulls the next title into the blurb column and
 *   every row after it is one cell out of step — a failure that only appears on a shop
 *   whose help index happens to have an article without a blurb.
 */

import { describe, expect, it } from "vitest";

import { sourceOf } from "../testing/source";

const help = sourceOf(process.cwd(), "app", "routes", "app.help.tsx");

/** The block that renders one section's articles. */
const start = help.indexOf("section.items.map");
const list = help.slice(start, help.indexOf("</s-grid>", start));

describe("the article list", () => {
  it("finds the list, so this cannot pass by checking nothing", () => {
    expect(list).toContain("item.title");
    expect(list).toContain("item.blurb");
  });

  it("lays the articles out in columns rather than on one line each", () => {
    // What encloses the rows, reading back from where they are rendered: a grid, not the
    // inline stack that was there — which looks perfectly reasonable in the source, which
    // is why it needs asserting.
    const before = help.slice(0, start);

    expect(before.lastIndexOf("<s-grid")).toBeGreaterThan(before.lastIndexOf("<ActionRow"));
  });

  it("renders a blurb cell even when the article has none", () => {
    // `{item.blurb ? … : null}` is the natural way to write it and it is the bug: the
    // row after a blurb-less article is one cell out of step, for ever.
    // `??` supplies an empty cell; a bare `?` decides whether to render one at all.
    expect(
      list,
      "a conditional cell shifts every row after it into the wrong column",
    ).not.toMatch(/item\.blurb \?(?!\?)/);
    expect(list).toMatch(/item\.blurb \?\?/);
  });

  it("still opens each article in a new tab from a root-relative href", () => {
    // An absolute URL in the frame takes `host`, `id_token` and `shop` with it and every
    // nav item goes inert. The note at the top of `app.help.tsx` has the detail.
    expect(list).toContain('target="_blank"');
    expect(list).toContain("${HELP_ROUTE}/${item.slug}");
  });
});
