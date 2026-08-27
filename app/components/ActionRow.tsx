import { Children, type ReactNode } from "react";

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
 * ## Why the row is a grid
 *
 * `s-button`, `s-link` and `s-clickable` are block-level, and an inline `s-stack` does
 * not change that: a stack of three actions renders as three lines. The cells of a grid
 * do, because it is the cell that decides where its child sits. Every action row in the
 * app had been rebuilding that grid by hand, one comma away from silently falling back to
 * a stacked column, which is what this exists to stop.
 *
 * `s-button-group` would be the obvious answer and is not usable here: it lays the row
 * out correctly and renders none of the buttons.
 */
export function ActionRow({ children }: { children: ReactNode }) {
  // Conditional actions are the norm — a Previous that only exists on page two — and
  // `false`/`null` children must not each claim a column, or the row develops gaps where
  // the actions that were not rendered would have been.
  const count = Children.toArray(children).length;

  return (
    <s-grid
      // A trailing `1fr` soaks up the slack so the actions stay tight to the left
      // instead of spreading across the card.
      //
      // One comma only. Polaris reads the comma as the separator between the responsive
      // value and the default, so a second one anywhere stops the whole value parsing and
      // it falls back to `none` — which stacks the row and looks like a layout choice.
      gridTemplateColumns={`@container (inline-size <= 460px) 1fr, ${"auto ".repeat(count)}1fr`}
      gap={SPACE.item}
      alignItems="center"
    >
      {children}
    </s-grid>
  );
}
