import type { ReactNode } from "react";

import { SPACE } from "../lib/ui/spacing";

/**
 * A row of actions, and the app's vocabulary for what an action looks like.
 *
 * ## The vocabulary
 *
 * The app was written almost entirely in links. Every way out of a card — a page to
 * visit, a row to open, a queue to review, a spreadsheet to import — was the same blue
 * underlined phrase, so a screen with four of them offered four things of apparently
 * equal weight and no clue which one it wanted you to press. Blue text is also the one
 * treatment Polaris reserves for *inline* links, where colour is the only thing marking a
 * word inside a sentence as clickable; spending it on standalone actions wastes it and
 * leaves a page looking like a bibliography.
 *
 * Four treatments, in descending loudness:
 *
 * - **`variant="primary"`** — the black button. The one thing a page or card most wants
 *   done: the next step in getting started, "Create campaign", "Sync catalogue". At most
 *   one per card; two black buttons is the same failure as four blue links.
 * - **`variant="secondary"`** (the default) — a real alternative, and every action inside
 *   a banner. Bordered, quiet, unmistakably pressable.
 * - **`variant="tertiary"`** — dark text with no chrome. Navigation and row-level actions
 *   that must not compete: "See everything", "Open", "View ledger", a product name that
 *   leads to the Shopify admin. This is the replacement for most of the old links, and
 *   the reason the pages stopped being blue.
 * - **`s-link`** — kept for exactly two things: a link *inside a sentence*, where colour
 *   is doing necessary work, and the App Bridge nav menu, which must be anchors.
 *
 * `s-button` takes an `href`, so a tertiary button that navigates is still an anchor —
 * middle-click and "open in new tab" behave the way a merchant expects.
 *
 * ## Why a component rather than a stack written out each time
 *
 * Not because a stack does not work — it does, and this is one. The app had been writing
 * that stack out at twenty-odd call sites with four different gaps between them, and a
 * row of actions is exactly the kind of thing whose spacing has to be the same everywhere
 * or the pages stop looking like one app. Naming it also gives the vocabulary above
 * somewhere to live that a reader will actually pass through.
 *
 * ## What is block-level here, precisely
 *
 * The checklist carried a comment saying `s-link` and `s-clickable` are block-level and
 * that an inline stack cannot lay them out in a row, and the first version of this
 * component repeated it and used a grid to work around it. Checked against the rendered
 * components, only **`s-clickable`** is: three of them in an inline stack render as three
 * lines, while buttons and links render as one row and *wrap* when they run out of width,
 * which a grid of fixed columns does not. So an inline stack is the right primitive, and
 * a grid is for the cases that genuinely need columns to line up — a status glyph, a
 * title, and an action pushed to the far edge, as the checklist rows do.
 */
export function ActionRow({ children }: { children: ReactNode }) {
  return (
    <s-stack direction="inline" gap={SPACE.item} alignItems="center">
      {children}
    </s-stack>
  );
}
