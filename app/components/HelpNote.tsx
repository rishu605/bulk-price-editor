import type { ReactNode } from "react";

import { ActionRow } from "./ActionRow";
import { PAD, SPACE } from "../lib/ui/spacing";

/**
 * The prose that explains a page, in an overlay under its title.
 *
 * Ten pages carried an explanation of themselves — what a baseline is, how two campaigns
 * resolve, why a floor is checked after rounding — and every one of them was an
 * `s-section slot="aside"`. That put roughly a hundred words in a 22rem column running the
 * full height of the page, next to the table the merchant actually came for. On the
 * catalogue the cost was blunt: seven columns of numbers squeezed into two thirds of the
 * screen so that three paragraphs could sit in the other third.
 *
 * The prose is not the problem — it is some of the best writing in the app, and the
 * baseline concept genuinely does need teaching. The problem is teaching all of it,
 * permanently, before anyone has asked. `OnboardingCard` had already reached that
 * conclusion for the checklist and its "Why?" toggle; this is the same move applied to
 * the rest of the app.
 *
 * So the aside column is reserved for **facts about this shop** — the store card and the
 * recent activity feed on the dashboard — and prose explaining how the app works is a
 * note: one line under the page title, opening into an overlay.
 *
 * ## Two things this got wrong first, both worth keeping written down
 *
 * **It was at the foot of the page.** The reasoning was that a note is a footnote and
 * pages are sized to fit a screen, so the foot is on screen. That is true of a full table
 * and false of every page that is shorter or longer than the estimate — and it puts the
 * answer to "what does this column mean?" below the thing the merchant is asking about,
 * so they have to leave the question to reach the answer. Help goes where the confusion
 * is, which is the top.
 *
 * **It expanded in place.** A disclosure that pushes the page down moves the table the
 * merchant is reading, at the exact moment they are trying to read it. `s-popover` is an
 * overlay: the panel is not in the page's flow at any point, so opening it moves nothing.
 * That is also why this holds no React state — `commandFor` makes the button the
 * popover's activator in the platform, and there is no open/closed for us to track, get
 * wrong, or re-render on.
 *
 * A popover rather than `s-tooltip`, which is hover-only and accepts text and paragraphs
 * only. Half of these notes carry a `<strong>` or an `s-badge`, and a definition a
 * merchant cannot pin open long enough to read is not a definition.
 *
 * `s-popover` supplies no padding of its own, so the box is not optional decoration —
 * without it the prose sits against the overlay's edge.
 *
 * ## `command` is required, whatever the documentation shows
 *
 * Every example on Shopify's popover page activates it with `commandFor` alone. That
 * renders a button which does nothing: the first version of this shipped that way,
 * looked correct in the admin, and silently had no help behind it.
 *
 * In `polaris.js` the activator's click handler is built as
 * `commandFor && command ? {...} : undefined`, and the handler re-checks `command` before
 * dispatching. With no `command` prop there is no listener at all — no error, no warning,
 * a button that is focusable and inert. Polaris' own colour field, the one place in the
 * runtime that opens a popover, passes `command: "--toggle"`.
 *
 * So `--toggle` here, matching the runtime rather than the docs. `--show` would open it
 * and leave no way to close it from the control that opened it.
 *
 * The prop is `label` and not `title` because what it names is a button's label, and
 * `control-vocabulary.test.ts` exempts exactly that: a bare `{identifier}` inside an
 * `s-button` is a domain value reaching the screen unless its name says a caller wrote the
 * words. Calling this what it is keeps that exemption a distinction rather than a hole.
 */
export function HelpNote({ label, children }: { label: string; children: ReactNode }) {
  const id = idFor(label);

  return (
    <ActionRow>
      {/* Tertiary, and a question mark rather than a chevron. The vocabulary in
          `ActionRow` reserves chrome for things the page wants done, and reading a
          definition is not one of them — but the icon still has to say at a glance that
          the line is help, because a merchant who does not know what "baseline" means is
          not scanning the page for the word "what". */}
      <s-button variant="tertiary" icon="question-circle" commandFor={id} command="--toggle">
        {label}
      </s-button>

      {/* Pixels, not rem: Polaris types `maxInlineSize` as px, % or 0 only.
          360 is a readable measure for prose — much wider and the overlay stops being a
          note and starts being the page again. */}
      <s-popover id={id} maxInlineSize="360px">
        <s-box padding={PAD.card}>
          <s-stack gap={SPACE.section}>{children}</s-stack>
        </s-box>
      </s-popover>
    </ActionRow>
  );
}

/**
 * The id linking the button to the overlay it opens.
 *
 * Derived from the label rather than `useId`, for two reasons. It is stable across a
 * server render and its hydration, which an id counter is only accidentally; and it is
 * legible in the DOM, so an overlay that does not open can be traced to the button that
 * should have opened it. One note per page, so the label is unique by construction.
 */
function idFor(label: string) {
  return `help-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")}`;
}
