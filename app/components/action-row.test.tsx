/**
 * The app's action vocabulary, guarded.
 *
 * Every way out of a card used to be the same blue underlined phrase, so a screen with
 * four of them offered four things of equal weight and no clue which one it wanted
 * pressed. `ActionRow` documents the replacement — primary, secondary, tertiary — and
 * this is what stops the links growing back one route at a time, which is exactly how
 * they arrived.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ActionRow } from "./ActionRow";

const APP = join(process.cwd(), "app");

/**
 * Where a bare `s-link` is still correct.
 *
 * The App Bridge nav menu must be anchors — Shopify reads them to build the sidebar, and
 * a button there renders nothing.
 *
 * A link *inside a sentence* is the other legitimate use, where colour is the only thing
 * marking a word mid-paragraph as clickable. There are none today. Adding one means
 * adding the file here, which is the point: it should be a decision somebody made, not a
 * habit that returned.
 */
const MAY_USE_LINKS = ["routes/app.tsx"];

function sources(dir: string): Array<{ path: string; text: string }> {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    if (!entry.name.endsWith(".tsx") || entry.name.includes(".test.")) return [];
    return [{ path: path.replace(`${APP}/`, ""), text: readFileSync(path, "utf8") }];
  });
}

describe("the action vocabulary", () => {
  it("keeps blue links out of everything but the nav", () => {
    const linking = sources(APP)
      .filter(({ text }) => text.includes("<s-link"))
      .map(({ path }) => path)
      .filter((path) => !MAY_USE_LINKS.includes(path));

    expect(
      linking,
      "use a button — primary, secondary or tertiary — and see ActionRow for which",
    ).toEqual([]);
  });

  it("offers at most one black button per card", () => {
    // Two black buttons on one card is the same failure as four blue links: nothing is
    // being pointed at. Per *card*, not per file — a settings page with two independent
    // forms in two sections is two surfaces, and each is entitled to its own.
    //
    // Found the campaign Actions card rendering "Apply to storefront" and "Resume" in
    // black at once, one of them disabled.
    const offenders = sources(APP)
      .flatMap(({ path, text }) =>
        text
          .split("<s-section")
          .slice(1)
          .map((card) => ({ path, primaries: (card.match(/variant="primary"/g) ?? []).length })),
      )
      .filter(({ primaries }) => primaries > 1)
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });
});

describe("the row itself", () => {
  const columns = (markup: string) => markup.match(/gridTemplateColumns="([^"]+)"/)?.[1];

  it("gives every action its own column, and the slack to a trailing one", () => {
    const markup = renderToStaticMarkup(
      <ActionRow>
        <s-button>One</s-button>
        <s-button>Two</s-button>
      </ActionRow>,
    );

    expect(columns(markup)).toContain("auto auto 1fr");
  });

  it("does not hand a column to an action that was not rendered", () => {
    // Conditional actions are the norm — a Previous that only exists on page two — and a
    // `false` child claiming a column leaves a gap where it would have been.
    const markup = renderToStaticMarkup(
      <ActionRow>
        {false}
        <s-button>Only</s-button>
      </ActionRow>,
    );

    expect(columns(markup)).toContain("auto 1fr");
    expect(columns(markup)).not.toContain("auto auto");
  });

  it("keeps one comma in the responsive value", () => {
    // Polaris splits on the comma to separate "when the query matches" from "otherwise".
    // A second comma anywhere stops the value parsing and it falls back to `none`, which
    // stacks the row into a column that looks like a deliberate layout.
    const markup = renderToStaticMarkup(
      <ActionRow>
        <s-button>One</s-button>
        <s-button>Two</s-button>
        <s-button>Three</s-button>
      </ActionRow>,
    );

    expect(columns(markup)?.split(",")).toHaveLength(2);
  });
});
