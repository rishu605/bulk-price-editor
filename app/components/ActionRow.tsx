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
 * equal weight and no clue which one it wanted you to press.
 *
 * The first answer to that was to remove the blue: `variant="tertiary"` — dark text with
 * no chrome — became the replacement for almost every link in the app. Rendered, that is
 * **plain static text**. "Why?", "See plans", "See everything", "Show archived", and every
 * campaign name in the list read as captions, and a merchant had no way to know that a
 * campaign's name was the way into it.
 *
 * Both of those are the same mistake from opposite ends: **loudness was being used to
 * carry two different things at once** — how much a page wants something pressed, and
 * whether it can be pressed at all. The second is not negotiable. Hierarchy is what
 * answers the four-equal-links problem, and one primary per card already provides it.
 *
 * So the question a caller answers is *what kind of thing is this*, and the loudness
 * follows:
 *
 * - **`s-link`** — navigation that is part of the content. A name in a table row, an
 *   article title in a list, a word inside a sentence. These are **read, then clicked**:
 *   the merchant is looking at the thing itself, and the link is the thing. Blue, because
 *   colour is what marks a word among words.
 * - **`variant="primary"`** — the black button. The one thing a page or card most wants
 *   done: "Create campaign", "Sync catalogue", the next step in getting started. At most
 *   one per card; two black buttons is the same failure as four blue links.
 * - **`variant="secondary"`** (the default) — a standalone action or destination that
 *   sits in a row of them. These are **looked for, then clicked**: the merchant has
 *   finished reading and wants to do something. Bordered, quiet, unmistakably pressable.
 * - **`variant="tertiary"`** — text with no border, **and only ever with an icon**. For a
 *   control repeated on every row of a table or every item of a list, where a border per
 *   row would be more ink than the rows. The icon is what makes it a control rather than
 *   a caption, so it is not optional; `action-row.test.tsx` refuses one without.
 *
 * ## Inside a table row
 *
 * The same four, with one extra question, because a table is scanned rather than read and
 * whatever is in the last column is repeated on every row.
 *
 * **A row action is quiet when it only reveals, and bordered when it changes something.**
 * Baselines' History opens a panel and closes it again, so it is tertiary; Duplicate makes
 * a campaign, Revert writes a price, and the drift queue's three decide what happens to a
 * price that moved — so those are secondary.
 *
 * That line was not being held: Price drift bordered its three from the start while the
 * campaigns list left Duplicate as text, so two tables were following different rules for
 * the same kind of control. `action-row.test.tsx` refuses a form submit inside a table
 * cell that renders as text.
 *
 * `s-button` takes an `href`, so a secondary button that navigates is still an anchor —
 * middle-click and "open in new tab" behave the way a merchant expects, whichever of
 * these it is.
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
