import { useState, type ReactNode } from "react";

import { ActionRow } from "./ActionRow";
import { SPACE } from "../lib/ui/spacing";

/**
 * The prose that explains a page, folded away until it is asked for.
 *
 * Ten pages carried an explanation of themselves — what a baseline is, how two campaigns
 * resolve, why a floor is checked after rounding — and every one of them was an
 * `s-section slot="aside"`. That put roughly a hundred words in a 22rem column running
 * the full height of the page, next to the table the merchant actually came for. On the
 * catalogue the cost was blunt: seven columns of numbers squeezed into two thirds of the
 * screen so that three paragraphs could sit in the other third, wrapping "Live price"
 * onto two lines while a quarter of the window stayed white.
 *
 * The prose is not the problem — it is some of the best writing in the app, and the
 * baseline concept genuinely does need teaching. The problem is teaching all of it,
 * permanently, before anyone has asked. `OnboardingCard` had already reached this
 * conclusion for the checklist and its "Why?" toggle; this is the same move applied to
 * the rest of the app.
 *
 * So the aside column is now reserved for **facts about this shop** — the store card,
 * recent activity, cost coverage, errors by kind — and prose explaining how the app works
 * becomes a note: one quiet line at the foot of the page, holding everything that used to
 * occupy the column.
 *
 * ## Why the foot of the page and not the top
 *
 * A note is a footnote. Put above the content it delays the thing the merchant came for
 * on every visit, forever, to answer a question they have on the first visit only. Pages
 * here are sized to fit a screen (`ROWS_PER_VIEW`), so the foot is on screen rather than
 * somewhere to scroll to — which is what makes a footnote findable rather than hidden.
 *
 * The divider is the part that does that work. Without it the toggle reads as one more
 * action belonging to the last card; with it, it reads as the page's own annotation.
 *
 * ## Two columns when it opens
 *
 * The panel spans the page, and a paragraph set across 1500px is not readable. Opening it
 * into two columns keeps the measure sane *and* keeps the panel short — three paragraphs
 * that were a tall thin column are now two short rows, so the content below is barely
 * pushed and the page does not jump.
 *
 * One comma in the responsive value, as everywhere else: Polaris splits on the comma to
 * separate "when the query matches" from "otherwise", and a second one anywhere in the
 * string stops the whole value parsing.
 *
 * The prop is `label` and not `title` because what it names is a button's label, and
 * `control-vocabulary.test.ts` exempts exactly that: a bare `{identifier}` inside an
 * `s-button` is a domain value reaching the screen unless its name says a caller wrote
 * the words. Calling this what it is keeps that exemption a distinction rather than a
 * hole.
 */
export function HelpNote({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);

  return (
    <s-stack gap={SPACE.section}>
      <s-divider />

      <ActionRow>
        {/* Tertiary, and a question mark rather than a chevron. The vocabulary in
            `ActionRow` reserves chrome for things the page wants done, and this is not
            one of them — but the icon still has to say at a glance that the line is help
            rather than a filter or a link away, because a merchant who does not know what
            "baseline" means is not scanning the bottom of the page for the word "what".

            The label does not change when it opens; the panel appearing underneath is the
            feedback. Assistive technology gets the state through `accessibilityLabel`,
            which is where a state change belongs when the visible text is a heading. */}
        <s-button
          variant="tertiary"
          icon="question-circle"
          accessibilityLabel={open ? `Hide: ${label}` : `Show: ${label}`}
          onClick={() => setOpen((shown) => !shown)}
        >
          {label}
        </s-button>
      </ActionRow>

      {open ? (
        <s-grid
          gridTemplateColumns="@container (inline-size <= 700px) 1fr, 1fr 1fr"
          gap={SPACE.section}
          alignItems="start"
        >
          {children}
        </s-grid>
      ) : null}
    </s-stack>
  );
}
