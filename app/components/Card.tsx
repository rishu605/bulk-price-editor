import type { ReactNode } from "react";

import { ActionRow } from "./ActionRow";
import { MEASURE } from "./FieldGrid";
import { Lede, Secondary } from "./Type";
import { SPACE } from "../lib/ui/spacing";

/**
 * A card, and the one place the distances inside one are decided.
 *
 * `PageShell` owns the rhythm *between* cards and says why it cannot be left to the
 * routes: "page rhythm has to be the largest gap on the screen to do its job. If a route
 * can set it, some route eventually sets it smaller than the gaps inside its own sections,
 * and the page stops having visible structure at all."
 *
 * The same argument applies one level down and nothing implemented it. Every `s-section`
 * in the app stacked its heading, its prose and its controls with whatever gap the route
 * happened to reach for, so on the deployed build at 4× zoom the guardrails card ran
 * heading → lede → secondary → checkbox → fields at four different distances, the
 * diagnostics card ran heading → sentence → label → field at a fifth, and Home's checklist
 * had a smaller gap above its first row than between its rows.
 *
 * ## The three distances, and why they are three
 *
 * - **Heading to content** is the largest of the three. It is the only lever this app has
 *   for making a heading read as a title: Polaris gives a card heading one weight and one
 *   size — `s-heading` and `s-section`'s own heading render identically to bold body text —
 *   and `type="small"` turned out not to be implemented by the runtime either (see
 *   `Type.tsx`). Air above the content is what is left, and it is enough: a title with room
 *   under it reads as a title even at the same size. That is #589, solved from here rather
 *   than from the type scale, because the type scale cannot solve it.
 * - **Between blocks** is the ordinary card rhythm — a paragraph and the fields under it,
 *   a table and the actions under it.
 * - **Lede to secondary** is the tightest. They are one thought: the sentence and its
 *   qualifier belong to each other more than either belongs to what follows, and spacing
 *   them like separate blocks is what made a card read as four unrelated paragraphs.
 *
 * All three are smaller than `SPACE.page`, which keeps the page's own structure the
 * strongest thing on the screen.
 *
 * ## What this does not take
 *
 * A `slot`. Cards that need something in the aside column say so with `slot="aside"` on an
 * `s-section` and `PageShell` partitions them out — wrapping that would mean this
 * component knowing about page layout, which is the level above it.
 */

/** Heading to content: the largest gap in a card, and the only thing making a title one. */
const HEADING_GAP = SPACE.section;

export function Card({
  heading,
  lede,
  secondary,
  actions,
  children,
}: {
  /** The card's title. Optional: a card can be one block of content with no title. */
  heading?: string;
  /** One sentence saying what this card is for. */
  lede?: ReactNode;
  /** What qualifies the lede — a count, a caveat, a consequence. */
  secondary?: ReactNode;
  /** The card's own actions, at its foot. */
  actions?: ReactNode;
  children?: ReactNode;
}) {
  /* The card's prose stops where its fields stop.

     A settings card's fields end at the measure and its lede ran the full width of the
     card, so one card had two right edges — the fields looked like they had given up a
     quarter of the space while the sentence above them had not. Prose has its own reason
     to be capped anyway: a line of text the width of this card is past the measure at
     which a reader reliably finds the start of the next one.

     Only the prose. A table, a preview or a set of tiles is content whose width is its
     own business, and capping those is how a card ends up with a column of white space
     down its right-hand side. */
  const intro =
    lede || secondary ? (
      <s-box maxInlineSize={MEASURE}>
        <s-stack gap={SPACE.tight}>
          {lede ? <Lede>{lede}</Lede> : null}
          {secondary ? <Secondary>{secondary}</Secondary> : null}
        </s-stack>
      </s-box>
    ) : null;

  return (
    <s-section heading={heading}>
      {/* The gap under the heading, which `s-section` does not give us a say in — so it
          is a box with padding at the top of the content rather than a prop. Without it
          the heading sits on the first line of prose and the card reads as a paragraph
          with a bold first line. */}
      <s-box paddingBlockStart={heading ? HEADING_GAP : "none"}>
        <s-stack gap={SPACE.section}>
          {intro}
          {children}
          {actions ? <ActionRow>{actions}</ActionRow> : null}
        </s-stack>
      </s-box>
    </s-section>
  );
}
