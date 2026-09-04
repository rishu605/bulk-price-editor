/**
 * The app's action vocabulary, guarded.
 *
 * It has been wrong in both directions. First every way out of a card was the same blue
 * underlined phrase, so a screen with four of them offered four things of apparently equal
 * weight. Then the fix removed the blue everywhere: `variant="tertiary"` — text with no
 * chrome — became the replacement for almost every link, and "Why?", "See plans" and every
 * campaign name in the list rendered as **plain static text**.
 *
 * Both are the same mistake from opposite ends. Loudness was carrying two things at once:
 * how much a page wants something pressed, and whether it can be pressed at all. The
 * second is not negotiable, and hierarchy — one primary per card — is what answers the
 * four-equal-links problem.
 *
 * So this file no longer bans a link. It holds the two rules that keep the vocabulary
 * legible: a tertiary control carries an icon, because that is the only thing separating
 * it from a caption; and a card offers at most one black button.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { sourceOf } from "../lib/testing/source";

import { ActionRow } from "./ActionRow";
import { SPACE } from "../lib/ui/spacing";

const APP = join(process.cwd(), "app");

function sources(dir: string): Array<{ path: string; text: string }> {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    if (!entry.name.endsWith(".tsx") || entry.name.includes(".test.")) return [];
    return [{ path: path.replace(`${APP}/`, ""), text: sourceOf(path) }];
  });
}

describe("the action vocabulary", () => {
  it("gives every tertiary control an icon", () => {
    // Tertiary is text with no border. Without an icon it is indistinguishable from a
    // caption, which is how a campaign name, "Why?" and "See plans" all came to look
    // like labels. The icon is what makes it a control, so it is not optional.
    const offenders = sources(APP).flatMap(({ path, text }) =>
      [...text.matchAll(/<s-button[^>]*?>/gs)]
        .filter((match) => match[0].includes('variant="tertiary"') && !match[0].includes("icon="))
        .map(() => path),
    );

    expect(
      [...new Set(offenders)],
      "a tertiary button with no icon renders as plain text — give it an icon, or make it secondary or a link",
    ).toEqual([]);
  });

  it("does not leave a row action that changes something looking like text", () => {
    // A table is scanned, not read, and whatever sits in the last column is repeated on
    // every row. A row action is quiet when it only reveals — Baselines' History opens a
    // panel and closes it again — and bordered when it changes state.
    //
    // Price drift bordered its three from the start while the campaigns list left
    // Duplicate as text, so two tables were following different rules for the same kind
    // of control.
    const offenders = sources(APP).flatMap(({ path, text }) =>
      [...text.matchAll(/<s-table-cell>[\s\S]*?<\/s-table-cell>/g)]
        .filter((cell) => /<s-button[^>]*type="submit"[^>]*variant="tertiary"/s.test(cell[0]))
        .map(() => path),
    );

    expect(
      [...new Set(offenders)],
      "a row action that submits changes something, so it is bordered",
    ).toEqual([]);
  });

  it("keeps a link for navigation rather than for actions", () => {
    // The other half of the rule. An `s-link` is content you read and then click, so it
    // goes somewhere; a link with no destination is a button wearing the wrong clothes.
    const offenders = sources(APP).flatMap(({ path, text }) =>
      [...text.matchAll(/<s-link[^>]*?>/gs)]
        .filter((match) => !match[0].includes("href"))
        .map(() => path),
    );

    expect(offenders, "an s-link with no href is an action, not navigation").toEqual([]);
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
  const markup = renderToStaticMarkup(
    <ActionRow>
      <s-button>One</s-button>
      <s-button>Two</s-button>
    </ActionRow>,
  );

  it("lays its actions out in a row that can wrap", () => {
    // An inline stack, not a grid of fixed columns. Checked against the rendered
    // components: buttons and links are not block-level — only `s-clickable` is — and a
    // stack wraps onto a second line when it runs out of width, where a grid overflows.
    expect(markup).toContain('direction="inline"');
    expect(markup).not.toContain("gridTemplateColumns");
  });

  it("puts one gap between actions everywhere in the app", () => {
    // The reason this is a component at all: twenty-odd call sites had been writing this
    // row out with four different gaps between them.
    expect(markup).toContain(`gap="${SPACE.item}"`);
  });
});
